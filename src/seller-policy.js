'use strict';

// Product prices are allowed. Seller earnings and compensation are never AI topics.
const restricted = /\b(comp(?:ensation)?|commissions?|comision(?:es)?|salary|salaries|sueldo[s]?|salario[s]?|remuneracion|bonuses?|bonos?|payouts?|paychecks?|earnings|affiliate[s]?|afiliado[s]?|profit[- ]?sharing|revenue[- ]?share)\b|\b(?:get|be|being) paid\b|\b(?:you|we|i|sellers?|reps?)\b.{0,20}\b(?:earn|make money)\b|\bper (?:order|sale|lead|referral)\b|\b(?:how much|what).{0,25}\b(?:i|we|seller[s]?|rep[s]?)\b.{0,15}\b(?:earn|make)\b|\bcuanto.{0,20}\b(?:gano|ganamos|ganar|pagan|me pagan)\b|\bpor (?:venta|lead|referido)\b/i;
const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const containsComp = (s) => restricted.test(plain(s));
const handoff = (es) => es ? 'Para esa pregunta, habla directamente con el responsable del equipo. Puedo ayudarte a ingresar un lead.' : 'Please ask the team lead directly about that question. I can help you enter a lead.';

function cleanKnowledge(text) {
  return String(text || '').split(/\n|(?<=[.!?])\s+/).filter((line) => !containsComp(line)).join('\n');
}

function cleanData(value) {
  if (Array.isArray(value)) return value.map(cleanData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/commission|compensation|affiliate|payout|earnings|salary|bonus/i.test(key))
    .map(([key, v]) => [key, cleanData(v)]));
  return typeof value === 'string' && containsComp(value) ? '[Restricted topic omitted]' : value;
}

module.exports = { containsComp, cleanKnowledge, cleanData, handoff };
