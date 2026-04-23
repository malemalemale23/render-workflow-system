import dotenv from "dotenv";
dotenv.config();

export const ENV = {
  redis: process.env.REDIS_URL,
  trelloKey: process.env.TRELLO_KEY,
  trelloToken: process.env.TRELLO_TOKEN,
};
