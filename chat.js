import { readFileSync } from 'fs';
const KEY = readFileSync('KEY', 'utf8').trim();

async function chat(messages) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: 'gpt-5.2',
      input: messages,
    }),
  });

  const data = await response.json();

  return {
    text: data.output[0].content[0].text,
    message: {
      role: 'assistant',
      content: data.output[0].content[0].text,
    },
  };
}

const conversation = [];

// Turn 1
conversation.push({ role: 'user', content: 'What is 25 * 48?' });
const answer1 = await chat(conversation);
console.log(answer1.text);
conversation.push(answer1.message);

// Turn 2
conversation.push({ role: 'user', content: 'Divide that by 4.' });
const answer2 = await chat(conversation);
console.log(answer2.text);
