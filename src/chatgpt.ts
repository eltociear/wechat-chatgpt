import { ChatGPTAPI, ChatGPTConversation } from "chatgpt";
import { Message } from "wechaty";
import { config } from "./config.js";
import { execa } from "execa";
import { Cache } from "./cache.js";
import { ContactInterface, RoomInterface } from "wechaty/impls";
import {
  IChatGPTItem,
  IConversationItem,
  isAccountWithUserInfo,
  isAccountWithSessionToken,
} from "./interface.js";
const SINGLE_MESSAGE_MAX_SIZE = 500;
const ErrorCode2Message: Record<string, string> = {
  "503":
    "OpenAI 服务器繁忙，请稍后再试| The OpenAI server is busy, please try again later",
  "429":
    "OpenAI 服务器限流，请稍后再试| The OpenAI server was limted, please try again later",
  "500":
    "OpenAI 服务器繁忙，请稍后再试| The OpenAI server is busy, please try again later",
  unknown: "未知错误，请看日志 | Error unknown, please see the log",
};
export class ChatGPTPoole {
  chatGPTPools: Array<IChatGPTItem> | [] = [];
  conversationsPool: Map<string, IConversationItem> = new Map();
  cache = new Cache("cache.json");
  async getSessionToken(email: string, password: string): Promise<string> {
    if (this.cache.get(email)) {
      return this.cache.get(email);
    }
    const cmd = `poetry run python3 src/generate_session.py ${email} ${password}`;
    const { stdout, stderr, exitCode } = await execa(`sh`, ["-c", cmd]);
    if (exitCode !== 0) {
      console.error(stderr);
      return "";
    }
    // The last line in stdout is the session token
    const lines = stdout.split("\n");
    if (lines.length > 0) {
      this.cache.set(email, lines[lines.length - 1]);
      return lines[lines.length - 1];
    }
    return "";
  }
  async startPools() {
    const sessionAccounts = config.chatGPTAccountPool.filter(
      isAccountWithSessionToken
    );
    const userAccounts = await Promise.all(
      config.chatGPTAccountPool
        .filter(isAccountWithUserInfo)
        .map(async (account) => {
          const session_token = await this.getSessionToken(
            account.email,
            account.password
          );
          return {
            ...account,
            session_token,
          };
        })
    );
    this.chatGPTPools = [...sessionAccounts, ...userAccounts].map((account) => {
      return {
        chatGpt: new ChatGPTAPI({
          sessionToken: account.session_token,
        }),
        account,
      };
    });
    console.log(`ChatGPTPools: ${this.chatGPTPools.length}`);
  }
  // Randome get chatgpt item form pool
  get chatGPTAPI(): IChatGPTItem {
    return this.chatGPTPools[
      Math.floor(Math.random() * this.chatGPTPools.length)
    ];
  }
  // Randome get conversation item form pool
  getConversation(talkid: string): IConversationItem {
    if (this.conversationsPool.has(talkid)) {
      return this.conversationsPool.get(talkid) as IConversationItem;
    }
    const chatGPT = this.chatGPTAPI;
    const conversation = chatGPT.chatGpt.getConversation();
    return {
      conversation,
      account: chatGPT.account,
    };
  }
  // send message with talkid
  async sendMessage(message: string, talkid: string) {
    const conversationItem = this.getConversation(talkid);
    const { conversation, account } = conversationItem;
    try {
      // TODO: Add Retry logic
      const response = await conversation.sendMessage(message);
      return response;
    } catch (err: any) {
      console.error(
        `err is ${err.message}, account ${JSON.stringify(err.account)}`
      );
      // If send message failed, we will remove the conversation from pool
      this.conversationsPool.delete(talkid);
      // Retry
      return this.error2msg(err);
    }
  }
  // Make error code to more human readable message.
  error2msg(err: Error): string {
    for (const code in Object.keys(ErrorCode2Message)) {
      if (err.message.includes(code)) {
        return ErrorCode2Message[code];
      }
    }
    return ErrorCode2Message.unknown;
  }
}
export class ChatGPTBot {
  // Record talkid with conversation id
  conversations = new Map<string, ChatGPTConversation>();
  chatGPTPool = new ChatGPTPoole();
  cache = new Cache("cache.json");
  botName: string = "";
  setBotName(botName: string) {
    this.botName = botName;
  }
  async startGPTBot() {
    await this.chatGPTPool.startPools();
  }
  // TODO: Add reset conversation id and ping pong
  async command(): Promise<void> {}
  // remove more times conversation and mention
  cleanMessage(text: string): string {
    let realText = text;
    const item = text.split("- - - - - - - - - - - - - - -");
    if (item.length > 1) {
      realText = item[item.length - 1];
    }
    // remove more text via - - - - - - - - - - - - - - -
    return realText;
  }
  async getGPTMessage(text: string, talkerId: string): Promise<string> {
    return await this.chatGPTPool.sendMessage(text, talkerId);
  }
  // The message is segmented according to its size
  async trySay(
    talker: RoomInterface | ContactInterface,
    mesasge: string
  ): Promise<void> {
    const messages: Array<string> = [];
    let message = mesasge;
    while (message.length > SINGLE_MESSAGE_MAX_SIZE) {
      messages.push(message.slice(0, SINGLE_MESSAGE_MAX_SIZE));
      message = message.slice(SINGLE_MESSAGE_MAX_SIZE);
    }
    messages.push(message);
    for (const msg of messages) {
      await talker.say(msg);
    }
  }
  async onMessage(message: Message) {
    const talker = message.talker();
    if (talker.self() || message.type() > 10 || talker.name() == "微信团队") {
      return;
    }
    const text = message.text();
    const room = message.room();
    if (!room) {
      console.log(`🎯 Hit GPT Enabled User: ${talker.name()}`);
      const response = await this.getGPTMessage(text, talker.id);
      await this.trySay(talker, response);
      return;
    }
    let realText = this.cleanMessage(text);
    // The bot should reply mention message
    if (!realText.includes(`@${this.botName}`)) {
      return;
    }
    realText = text.replace(`@${this.botName}`, "");
    const topic = await room.topic();
    console.debug(
      `receive message: ${realText} from ${talker.name()} in ${topic}, room: ${
        room.id
      }`
    );
    console.log(`Hit GPT Enabled Group: ${topic} in room: ${room.id}`);
    const response = await this.getGPTMessage(realText, talker.id);
    const result = `${realText}\n ------\n ${response}`;
    await this.trySay(room, result);
  }
}
