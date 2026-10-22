// Grade 1 maths: small additions and subtractions with every number from 0 to 20.
//
// A question is {a, op, b, answer, text}. Additions never add up to more than 20 and subtractions never go
// below zero, so a child never meets a negative number or anything bigger than 20.

export const MAX_NUMBER = 20;
export const MAX_ANSWER_DIGITS = 2;

/**
 * @param {() => number} rng random source in [0,1)
 * @param {{a:number, op:string, b:number}|null} [previous] never repeat the question just asked
 */
export function makeQuestion(rng = Math.random, previous = null) {
  for (let guard = 0; guard < 20; guard++) {
    const op = rng() < 0.5 ? '+' : '-';
    let a, b;
    if (op === '+') {
      a = 1 + Math.floor(rng() * (MAX_NUMBER - 1));          // 1..19
      b = 1 + Math.floor(rng() * (MAX_NUMBER - a));          // 1..20-a, so the sum is at most 20
    } else {
      a = 2 + Math.floor(rng() * (MAX_NUMBER - 1));          // 2..20
      b = 1 + Math.floor(rng() * (a - 1));                   // 1..a-1, so the answer is at least 1
    }
    if (previous && previous.a === a && previous.b === b && previous.op === op) continue;
    const answer = op === '+' ? a + b : a - b;
    return { a, op, b, answer, text: `${a} ${op === '+' ? '+' : '−'} ${b}` };
  }
  return { a: 1, op: '+', b: 1, answer: 2, text: '1 + 1' };
}

/** Is the typed answer (a string of digits or a number) right for the question? */
export function isCorrect(question, typed) {
  if (typed === '' || typed == null) return false;
  const n = typeof typed === 'number' ? typed : Number(typed);
  return Number.isInteger(n) && n === question.answer;
}
