import axios from "axios";

const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

export async function createCard(name, listId) {
  return axios.post(`https://api.trello.com/1/cards`, null, {
    params: {
      key,
      token,
      name,
      idList: listId,
    },
  });
}
