import axios from "axios";

const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

export async function createCard(name, listId) {
  const res = await axios.post(`https://api.trello.com/1/cards`, null, {
    params: { key, token, name, idList: listId },
  });
  return res.data;
}

export async function createChecklist(cardId, name) {
  const res = await axios.post(`https://api.trello.com/1/checklists`, null, {
    params: { key, token, idCard: cardId, name },
  });
  return res.data;
}

export async function addChecklistItem(checklistId, name) {
  const res = await axios.post(
    `https://api.trello.com/1/checklists/${checklistId}/checkItems`,
    null,
    { params: { key, token, name } }
  );
  return res.data;
}
