'use strict';

const EVENTS = {
  ordered: 'Lead ordered',
  owner_mention: 'Owner mentioned',
  lead_updates: 'Other lead status changes',
  assignments: 'Assignments and leads entered for you',
  comments: 'Comments and other mentions',
  new_leads: 'New leads',
  reminders: 'Reminders',
  escalations: 'Waiting-lead alerts',
  coaching_review: 'Coaching approvals',
  general: 'Other app alerts',
};
const URGENT = ['ordered', 'owner_mention'];
function defaults() {
  return {
    events: Object.fromEntries(
      Object.keys(EVENTS).map((event) => [
        event,
        { email: true, push: true, whatsapp: URGENT.includes(event) },
      ])
    ),
    automatic_coaching: false,
  };
}
function read(raw) {
  const out = defaults();
  let value = {};
  try {
    value = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
  } catch {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  for (const event of Object.keys(EVENTS))
    for (const channel of ['email', 'push', 'whatsapp']) {
      if (typeof value.events?.[event]?.[channel] === 'boolean')
        out.events[event][channel] = value.events[event][channel];
      if (channel === 'whatsapp' && !URGENT.includes(event))
        out.events[event][channel] = false;
    }
  if (typeof value.automatic_coaching === 'boolean')
    out.automatic_coaching = value.automatic_coaching;
  return out;
}
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Choose your notification preferences.');
  if (
    value.events !== undefined &&
    (!value.events ||
      typeof value.events !== 'object' ||
      Array.isArray(value.events))
  )
    throw new Error('Choose notification events.');
  for (const [event, channels] of Object.entries(value.events || {})) {
    if (
      !Object.hasOwn(EVENTS, event) ||
      !channels ||
      typeof channels !== 'object' ||
      Array.isArray(channels)
    )
      throw new Error('Unknown notification event.');
    for (const [channel, on] of Object.entries(channels)) {
      if (
        !['email', 'push', 'whatsapp'].includes(channel) ||
        typeof on !== 'boolean'
      )
        throw new Error('Notification choices must be on or off.');
      if (channel === 'whatsapp' && on && !URGENT.includes(event))
        throw new Error(
          'WhatsApp alerts are available only for orders and owner mentions.'
        );
    }
  }
  if (
    value.automatic_coaching !== undefined &&
    typeof value.automatic_coaching !== 'boolean'
  )
    throw new Error('Choose whether to receive automatic coaching.');
  return read(value);
}
const allows = (raw, event, channel) =>
  !!read(raw).events[Object.hasOwn(EVENTS, event) ? event : 'general']?.[
    channel
  ];
module.exports = { EVENTS, URGENT, read, validate, allows };
