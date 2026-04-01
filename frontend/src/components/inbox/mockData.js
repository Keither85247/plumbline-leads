// Mock conversations + messages for Inbox UI development.
// Replace with real API calls (GET /api/conversations, GET /api/messages/:id) when ready.

function ago(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

export const MOCK_CONVERSATIONS = [
  {
    id: '1',
    name: 'Mike Rosenberg',
    phone: '+15165554321',
    lastMessage: 'Yeah that works, see you Thursday',
    lastMessageDir: 'inbound',
    timestamp: ago(0.4),
    unread: 2,
    status: 'New',
    category: 'Likely Lead',
    company: null,
    notes: 'Wants water heater replaced. 40-gal gas, basement unit about 12 years old.',
  },
  {
    id: '2',
    name: 'Sandra Perez',
    phone: '+15165558872',
    lastMessage: 'Sounds good, thanks Keith',
    lastMessageDir: 'outbound',
    timestamp: ago(26),
    unread: 0,
    status: 'Contacted',
    category: 'Existing Customer',
    company: 'Perez Realty',
    notes: 'Recurring customer. Always pays promptly. Has a rental portfolio on the island.',
  },
  {
    id: '3',
    name: 'Tom Nguyen',
    phone: '+15165551234',
    lastMessage: "What's the earliest you can come?",
    lastMessageDir: 'inbound',
    timestamp: ago(2),
    unread: 1,
    status: 'New',
    category: 'Likely Lead',
    company: null,
    notes: '',
  },
  {
    id: '4',
    name: 'Lauren Kim',
    phone: '+15165559876',
    lastMessage: "I'll pass your number along to my neighbor",
    lastMessageDir: 'inbound',
    timestamp: ago(96),
    unread: 0,
    status: 'Qualified',
    category: 'Existing Customer',
    company: null,
    notes: 'Referred us to a neighbor on Elm St. Follow up end of week.',
  },
  {
    id: '5',
    name: 'Carlos Mendez',
    phone: '+15165552468',
    lastMessage: 'The leak is getting worse, can you come today?',
    lastMessageDir: 'inbound',
    timestamp: ago(120),
    unread: 0,
    status: 'New',
    category: 'Likely Lead',
    company: 'Mendez Construction',
    notes: '',
  },
];

export const MOCK_MESSAGES = {
  '1': [
    { id: 'm1-1', body: 'Hi, I need a quote for a water heater replacement. 40 gallon, Bradford White.', direction: 'inbound',  ts: ago(5) },
    { id: 'm1-2', body: 'Hi Mike! Can you confirm the current unit — gas or electric?',                  direction: 'outbound', ts: ago(4.9) },
    { id: 'm1-3', body: "It's gas. About 12 years old. Located in the basement.",                       direction: 'inbound',  ts: ago(4.8) },
    { id: 'm1-4', body: 'Got it. I can do a 40-gal Rheem Power Vent for $1,150 installed. Thursday morning work?', direction: 'outbound', ts: ago(4.5) },
    { id: 'm1-5', body: 'Yeah that works, see you Thursday',                                            direction: 'inbound',  ts: ago(0.4) },
  ],
  '2': [
    { id: 'm2-1', body: 'Hi Sandra, following up on the faucet repair from last month — everything still good?', direction: 'outbound', ts: ago(30) },
    { id: 'm2-2', body: 'Yes, all good! Actually I have another job — kitchen sink is draining slow.',   direction: 'inbound',  ts: ago(28) },
    { id: 'm2-3', body: 'Happy to take a look. I can be there Tuesday afternoon.',                       direction: 'outbound', ts: ago(27) },
    { id: 'm2-4', body: 'Sounds good, thanks Keith',                                                    direction: 'outbound', ts: ago(26) },
  ],
  '3': [
    { id: 'm3-1', body: 'Hello, I got your number from Google. I have a burst pipe in my bathroom.',    direction: 'inbound',  ts: ago(60) },
    { id: 'm3-2', body: 'Hi Tom! Shut off the main valve if you can. I can be there within 2 hours. Address?', direction: 'outbound', ts: ago(59.5) },
    { id: 'm3-3', body: '123 Oak Street, Garden City. Main is off.',                                    direction: 'inbound',  ts: ago(59) },
    { id: 'm3-4', body: 'On my way. See you by 3pm.',                                                   direction: 'outbound', ts: ago(58.8) },
    { id: 'm3-5', body: "What's the earliest you can come?",                                            direction: 'inbound',  ts: ago(2) },
  ],
  '4': [
    { id: 'm4-1', body: 'Keith, great job on the bathroom remodel last week!',                          direction: 'inbound',  ts: ago(100) },
    { id: 'm4-2', body: "Thank you Lauren! Really appreciate it. Let me know if anything needs a touch-up.", direction: 'outbound', ts: ago(99) },
    { id: 'm4-3', body: "I'll pass your number along to my neighbor",                                   direction: 'inbound',  ts: ago(96) },
  ],
  '5': [
    { id: 'm5-1', body: 'The leak is getting worse, can you come today?',                               direction: 'inbound',  ts: ago(120) },
  ],
};
