#!/usr/bin/env node
/**
 * Demo data seed — populates the demo user account with realistic fake records.
 *
 * KEY POINTS FORMAT — must use structured "Label: value" for proper tag rendering:
 *   "Type of Work: ..."      → 🔧 job chip
 *   "Job Location: City, ST" → 📍 location chip
 *   Plain sentence (no colon)→ 💬 speech bubble
 *   Any other "Label: value" → silently dropped
 *
 * Valid statuses:   New | Contacted | Qualified | Closed
 * Valid categories: Lead | Existing Customer | Vendor | Spam | Other
 *
 * To seed PRODUCTION use the API endpoint (runs on Render, hits the real DB):
 *   POST /api/admin/reset-demo  (owner session cookie required)
 *
 * Local dev only:
 *   node scripts/seed-demo.js <userId>
 */
'use strict';

const db = require('../db');

function daysAgo(n, hoursOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  if (hoursOffset) d.setHours(d.getHours() - hoursOffset);
  const p = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function seedDemoData(userId) {

  // ── Contacts ─────────────────────────────────────────────────────────────────
  const insertContact = db.prepare(`
    INSERT OR IGNORE INTO contacts
      (user_id, phone, name, email, address_line_1, city, state, postal_code, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const CONTACTS = [
    // Leads
    { phone: '+15558472391', name: 'Sarah Johnson',    email: 'sarah.johnson@gmail.com',   addr: '742 Evergreen Terrace',  city: 'Springfield',   state: 'IL', zip: '62701', notes: 'Referred by Mike Chen.' },
    { phone: '+15552093847', name: 'Marcus Thompson',  email: 'marcus.t@outlook.com',      addr: '318 Birchwood Drive',    city: 'Naperville',    state: 'IL', zip: '60540', notes: 'Family of 5, urgent water heater.' },
    { phone: '+15554812903', name: 'Jennifer Park',    email: 'jenniferp@yahoo.com',       addr: '99 Oakmont Circle',      city: 'Lombard',       state: 'IL', zip: '60148', notes: 'AC emergency during heat wave.' },
    { phone: '+15559034712', name: 'David Reyes',      email: 'dreyes.home@gmail.com',     addr: '55 Cardinal Lane',       city: 'Downers Grove', state: 'IL', zip: '60515', notes: 'Full bathroom gut, budget ~$18k.' },
    { phone: '+15552348876', name: 'Mike Chen',        email: 'mchen.home@outlook.com',    addr: '1450 Oak Ridge Blvd',    city: 'Riverside',     state: 'IL', zip: '60546', notes: 'Prev customer — water heater 2022.' },
    { phone: '+15557823091', name: 'Tom Bradley',      email: 'tombradley55@gmail.com',    addr: '211 Willow Glen Court',  city: 'Westmont',      state: 'IL', zip: '60559', notes: 'Furnace job done. Good referral source.' },
    // Existing customers
    { phone: '+15551047823', name: 'Linda Castro',     email: 'lcastro.home@icloud.com',   addr: '403 Redwood Way',        city: 'Addison',       state: 'IL', zip: '60101', notes: 'Repeat customer — 3 jobs this year.' },
    { phone: '+15553829104', name: 'Robert Kim',       email: 'r.kim.home@gmail.com',      addr: '29 Pinecrest Drive',     city: 'Elmhurst',      state: 'IL', zip: '60126', notes: 'Annual maintenance customer. Very reliable payer.' },
    // Vendor
    { phone: '+15551204800', name: 'Ferguson Plumbing Supply', email: 'orders@fergusonplumbing.com', addr: '4400 Commerce Drive', city: 'Lisle', state: 'IL', zip: '60532', notes: 'Primary parts supplier. Account #PLB-8847.' },
    { phone: '+15558831290', name: 'Tony Marino',      email: 'tony@marinoelectric.com',   addr: '771 Industrial Pkwy',    city: 'Naperville',    state: 'IL', zip: '60563', notes: 'Electrical sub — solid work, reasonable rates.' },
  ];

  for (const c of CONTACTS) {
    insertContact.run(userId, c.phone, c.name, c.email, c.addr, c.city, c.state, c.zip, c.notes, daysAgo(0));
  }

  // ── Leads ─────────────────────────────────────────────────────────────────────
  const insertLead = db.prepare(`
    INSERT INTO leads
      (user_id, transcript, contact_name, company_name, phone_number, callback_number,
       summary, key_points, follow_up_text, category, status, source, archived, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);

  const leads = [

    // ════════════════════════════════════════════════════════════════════════════
    // LEADS tab — 7 leads (3 New / 2 Contacted / 1 Qualified / 1 Closed)
    // ════════════════════════════════════════════════════════════════════════════

    {
      phone: '+15558472391', name: 'Sarah Johnson', company: null,
      transcript: "Hi this is Sarah Johnson calling. I've got a leaky kitchen faucet that's been dripping for about two weeks now and it's getting a lot worse. I'm also seeing some water under the cabinet. I'm at 742 Evergreen Terrace in Springfield. My number is 555-847-2391. Any afternoon this week works.",
      summary: 'Sarah Johnson – Leaking kitchen faucet, 2 weeks and worsening. Water visible under cabinet.',
      points: ['Type of Work: Leaky kitchen faucet', 'Job Location: Springfield, IL', 'Available any afternoon this week'],
      followup: "Hi Sarah, I got your message about the leaky faucet. I'm just finishing up a job right now — can I call you back in just a bit to go over it?",
      category: 'Lead', status: 'New', source: 'voicemail', daysAgo: 0,
    },

    {
      phone: '+15552093847', name: 'Marcus Thompson', company: null,
      transcript: "Hey this is Marcus Thompson at 318 Birchwood Drive in Naperville. My water heater has been making a loud popping and rumbling sound for the last couple days. Family of five so we really can't be without hot water. Can you come out as soon as possible? 555-209-3847.",
      summary: 'Marcus Thompson – Water heater rumbling and popping. Family of 5, urgent.',
      points: ['Type of Work: Water heater making noise', 'Job Location: Naperville, IL', 'Needs someone as soon as possible'],
      followup: "Hi Marcus, I got your message about the water heater. I'm just finishing up a job now — can I call you back in a few minutes to go over it?",
      category: 'Lead', status: 'New', source: 'voicemail', daysAgo: 0,
    },

    {
      phone: '+15554812903', name: 'Jennifer Park', company: null,
      transcript: "Hi I'm calling about my air conditioning. It's running constantly but the house will not cool below 80 degrees. It's been two days. I'm at 99 Oakmont Circle in Lombard. Jennifer Park, my cell is 555-481-2903. Please call me back as soon as you can.",
      summary: "Jennifer Park – AC running nonstop, not cooling below 80°F for 2 days.",
      points: ['Type of Work: AC not cooling', 'Job Location: Lombard, IL', 'Urgent — please call back as soon as possible'],
      followup: "Hi Jennifer, I got your message about the AC. I'm just finishing up a job right now — can I call you back in just a bit to go over it?",
      category: 'Lead', status: 'New', source: 'voicemail', daysAgo: 2,
    },

    {
      phone: '+15559034712', name: 'David Reyes', company: null,
      transcript: "Hi this is David Reyes at 55 Cardinal Lane in Downers Grove. I'm looking to do a full bathroom renovation — new toilet, new vanity, walk-in shower replacing the tub. I want to get a quote. We're ready to move forward this fall. Please call me back at 555-903-4712.",
      summary: 'David Reyes – Full bathroom reno: toilet, vanity, tub-to-shower. Ready to start this fall.',
      points: ['Type of Work: Full bathroom renovation', 'Job Location: Downers Grove, IL', 'Targeting a fall start date'],
      followup: "Hi David, I got your message about the bathroom renovation. I'm just finishing up a job — can I call you back in just a bit to go over the details?",
      category: 'Lead', status: 'Contacted', source: 'voicemail', daysAgo: 3,
    },

    {
      phone: '+15559014455', name: 'Dave', company: 'Demo Construction LLC',
      transcript: "This is Dave from Demo Construction LLC. We have a commercial property at 3300 Industrial Park Drive that we're acquiring and need a full HVAC inspection before closing next month. About 8,000 square feet, systems haven't been serviced in years. Need a detailed written report with photos for our lender. Call back at 555-901-4455.",
      summary: 'Dave (Demo Construction LLC) – Commercial HVAC inspection, 8,000 sq ft. Lender report required.',
      points: ['Type of Work: Commercial HVAC inspection', 'Job Location: Bartlett, IL', 'Written report with photos required for lender'],
      followup: "Hi Dave, I got your message about the HVAC inspection at 3300 Industrial Park. I'm just finishing up another job — can I call you back in a few minutes to talk through the scope?",
      category: 'Lead', status: 'Contacted', source: 'voicemail', daysAgo: 4,
    },

    {
      phone: '+15552348876', name: 'Mike Chen', company: null,
      transcript: "Hey it's Mike Chen, I'm at 1450 Oak Ridge over in Riverside. My water heater is about 12 years old and I'm getting rust-colored water in the mornings. I'm thinking I want to go tankless. Can you call me back? 555-234-8876.",
      summary: 'Mike Chen – 12-yr water heater with rust discoloration. Wants tankless replacement. Quote sent.',
      points: ['Type of Work: Water heater replacement', 'Job Location: Riverside, IL', 'Wants tankless — $2,100 quote sent, awaiting decision'],
      followup: "Hi Mike, just following up on the tankless quote I sent over. I'm finishing up a job — can I call you back in a bit to answer any questions?",
      category: 'Lead', status: 'Qualified', source: 'voicemail', daysAgo: 5,
    },

    {
      phone: '+15557823091', name: 'Tom Bradley', company: null,
      transcript: "Hi there, this is Tom Bradley at 211 Willow Glen Court in Westmont. My furnace stopped working last night and it's freezing in here. I need someone out today if possible. Number is 555-782-3091.",
      summary: 'Tom Bradley – Emergency furnace call. Faulty igniter replaced same day. Job closed.',
      points: ['Type of Work: Furnace not working', 'Job Location: Westmont, IL', 'Emergency call — came out same day, job complete'],
      followup: "Hi Tom, I got your message about the furnace. I know that's urgent — I'm just finishing up down the road and can swing by within the hour. Does that work?",
      category: 'Lead', status: 'Closed', source: 'voicemail', daysAgo: 7,
    },

    // ════════════════════════════════════════════════════════════════════════════
    // EXISTING CUSTOMERS tab — 2 leads
    // ════════════════════════════════════════════════════════════════════════════

    {
      phone: '+15551047823', name: 'Linda Castro', company: null,
      transcript: "Hi it's Linda Castro again at 403 Redwood Way in Addison. You guys came out earlier this year for the garbage disposal and did a great job. Now I've got a slow drain in the master bathroom, it's pretty much completely backed up. Can someone come out this week? My cell is 555-104-7823.",
      summary: 'Linda Castro – Master bath drain fully backed up. Returning customer.',
      points: ['Type of Work: Clogged bathroom drain', 'Job Location: Addison, IL', 'Available any time this week'],
      followup: "Hi Linda, great to hear from you again! I got your message about the drain. I'm just finishing up a job now — can I call you back in just a bit?",
      category: 'Existing Customer', status: 'New', source: 'voicemail', daysAgo: 1,
    },

    {
      phone: '+15553829104', name: 'Robert Kim', company: null,
      transcript: "Hi this is Robert Kim over on Pinecrest in Elmhurst. We did the annual furnace tune-up last fall, right? I want to schedule the AC tune-up before summer gets here. Also one of my bathroom faucets has been dripping a little. Can we get both done in the same visit? Number is 555-382-9104.",
      summary: 'Robert Kim – Annual AC tune-up + dripping bathroom faucet. Wants to combine into one visit.',
      points: ['Type of Work: AC tune-up + faucet repair', 'Job Location: Elmhurst, IL', 'Wants both done in one visit before summer'],
      followup: "Hi Robert, I got your message about the AC tune-up and the faucet. I'm just finishing up a job — can I call you back in just a bit to get you on the schedule?",
      category: 'Existing Customer', status: 'Contacted', source: 'voicemail', daysAgo: 3,
    },

    // ════════════════════════════════════════════════════════════════════════════
    // VENDORS / SUPPLIERS tab — 2 leads
    // ════════════════════════════════════════════════════════════════════════════

    {
      phone: '+15551204800', name: 'Ferguson Plumbing Supply', company: 'Ferguson Plumbing Supply',
      transcript: "Hi this is a message for your account from Ferguson Plumbing Supply on Commerce Drive in Lisle. Your order number 12847 is ready for pickup — that includes the 3/4-inch copper fittings, the PEX tubing, and the Rinnai RU199iN unit you ordered last week. We're open Monday through Friday 7am to 5pm. Give us a call at 555-120-4800 if you have any questions.",
      summary: 'Ferguson Plumbing Supply – Order #12847 ready for pickup: copper fittings, PEX, Rinnai RU199iN.',
      points: ['Parts order ready for pickup', 'Job Location: Lisle, IL', 'Open Mon–Fri 7am–5pm, call 555-120-4800'],
      followup: "Hi, got the message that order #12847 is ready. I'm finishing up a job now — I'll swing by this afternoon to grab it.",
      category: 'Vendor', status: 'New', source: 'voicemail', daysAgo: 1,
    },

    {
      phone: '+15558831290', name: 'Tony Marino', company: 'Marino Electric',
      transcript: "Hey this is Tony Marino from Marino Electric over in Naperville. I heard through the grapevine you're working on that bathroom remodel on Cardinal Lane in Downers Grove. I do all the electrical work in that area — panel upgrades, GFCI, lighting, the whole bit. Thought it might be worth a conversation if you need an electrical sub on that job. Give me a call at 555-883-1290.",
      summary: "Tony Marino (Marino Electric) – Electrical sub reaching out about the Cardinal Lane bathroom remodel. Looking to partner.",
      points: ['Electrical sub — panel, GFCI, lighting', 'Job Location: Naperville, IL', 'Interested in the Cardinal Lane remodel job'],
      followup: "Hey Tony, I got your message about Cardinal Lane. I'm finishing up a job right now — can I call you back in a bit? That remodel is going to need electrical work for sure.",
      category: 'Vendor', status: 'New', source: 'voicemail', daysAgo: 2,
    },

    // ════════════════════════════════════════════════════════════════════════════
    // SPAM tab — 2 leads
    // ════════════════════════════════════════════════════════════════════════════

    {
      phone: '+18005559283', name: 'Unknown', company: null,
      transcript: "Hello, this is an important message regarding your vehicle's extended warranty. Your coverage may have recently expired or is about to expire. Please call us back immediately at 1-800-555-9283 to speak with a warranty specialist. This is your final notice.",
      summary: 'Spam – Vehicle warranty robocall.',
      points: ['Vehicle warranty robocall', 'Automated call, no real caller', 'No action needed'],
      followup: '',
      category: 'Spam', status: 'Closed', source: 'voicemail', daysAgo: 3,
    },

    {
      phone: '+17735558841', name: 'Unknown', company: 'Digital Reach Marketing',
      transcript: "Hi there, my name is Brittany calling from Digital Reach Marketing. We help local contractors just like you get more leads through Google and social media. I'd love to share how we helped a plumber in your area increase their calls by 300 percent last month. Give me a call back at 773-555-8841 to learn more. Have a great day.",
      summary: 'Spam – Cold call from marketing company pitching SEO / lead gen services.',
      points: ['Marketing cold call — lead generation pitch', 'Claims 300% increase in calls', 'No action needed'],
      followup: '',
      category: 'Spam', status: 'Closed', source: 'voicemail', daysAgo: 5,
    },

    // ════════════════════════════════════════════════════════════════════════════
    // OTHER tab — 2 leads
    // ════════════════════════════════════════════════════════════════════════════

    {
      phone: '+16305557734', name: 'Unknown', company: null,
      transcript: "Hi I'm trying to reach Bob's Landscaping? I need someone to come out and do some hedge trimming and I was told to call this number. If this isn't Bob's Landscaping please disregard this message. My number is 630-555-7734. Thanks.",
      summary: 'Wrong number – Caller looking for Bob\'s Landscaping. No action needed.',
      points: ['Wrong number — looking for a landscaping company', 'Job Location: Unknown', 'No action needed'],
      followup: "Hi, I got your message — I think you may have the wrong number. I'm a plumber, not a landscaping service. Hope you find what you're looking for!",
      category: 'Other', status: 'Closed', source: 'voicemail', daysAgo: 4,
    },

    {
      phone: '+13125559901', name: 'Unknown', company: null,
      transcript: "Yeah hi, uh, I got a question about my lease. I'm in unit 4B and my landlord gave me this number and said to call if I had maintenance issues. The uh, the hot water in my shower has been lukewarm for like a week. Can someone come look at it? I'm at the Maple Park apartments. My name is Carlos. 312-555-9901.",
      summary: 'Carlos – Lukewarm shower water at Maple Park Apartments. Likely tenant calling a wrong/old number.',
      points: ['Type of Work: Hot water issue', 'Job Location: Chicago, IL', 'Tenant call — verify if landlord is a client before scheduling'],
      followup: "Hi Carlos, I got your message about the hot water. I'm just finishing up a job — can I call you back in a bit to figure out who your landlord is and get this sorted out?",
      category: 'Other', status: 'New', source: 'voicemail', daysAgo: 1,
    },

  ];

  for (const l of leads) {
    insertLead.run(
      userId,
      l.transcript,
      l.name,
      l.company || null,
      l.phone,
      l.phone,
      l.summary,
      JSON.stringify(l.points),
      l.followup,
      l.category,
      l.status,
      l.source,
      daysAgo(l.daysAgo)
    );
  }

  // ── Calls ─────────────────────────────────────────────────────────────────────
  const insertCall = db.prepare(`
    INSERT INTO calls
      (user_id, from_number, call_sid, classification, status, duration,
       transcript, summary, key_points, contractor_note, outcome, is_seen, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  insertCall.run(userId, '+15558472391', 'CA_demo_001', 'new-lead', 'voicemail', 48,
    "Hi this is Sarah Johnson calling. I've got a leaky kitchen faucet that's been dripping for about two weeks...",
    'Voicemail — Sarah Johnson, leaky kitchen faucet.',
    JSON.stringify(['Leaky faucet 2+ weeks', 'Water under cabinet']),
    null, null, daysAgo(0));

  insertCall.run(userId, '+15552093847', 'CA_demo_002', 'new-lead', 'voicemail', 39,
    "Hey this is Marcus Thompson. My water heater has been making a loud popping and rumbling sound...",
    'Voicemail — Marcus Thompson, noisy water heater, urgent.',
    JSON.stringify(['Rumbling water heater', 'Family of 5, needs ASAP']),
    null, null, daysAgo(0));

  insertCall.run(userId, '+15554812903', 'CA_demo_003', 'new-lead', 'missed', 0,
    null, null, null, null, null, daysAgo(2));

  insertCall.run(userId, '+15559034712', 'CA_demo_004', 'new-lead', 'completed', 284,
    null, null, null,
    "Talked to David about the bathroom reno. Full gut — tub-to-shower, comfort-height toilet, floating vanity. Quoted $12,500–$16,000 depending on tile. He's reviewing with wife, will follow up next week.",
    'answered', daysAgo(3));

  insertCall.run(userId, '+15552348876', 'CA_demo_005', 'existing-customer', 'completed', 318,
    null, null, null,
    "Talked to Mike about tankless. He wants the Rinnai RU199iN. Quoted $2,100 installed — includes upgrading gas line to 3/4\". He's deciding by end of week.",
    'answered', daysAgo(5));

  insertCall.run(userId, '+15557823091', 'CA_demo_006', 'new-lead', 'voicemail', 22,
    "Hi this is Tom Bradley. My furnace stopped working last night and it's freezing in here...",
    'Emergency voicemail — Tom Bradley, furnace out.',
    JSON.stringify(['Furnace out overnight', 'Emergency same-day']),
    "Went out same day. Bad igniter replaced on-site, 90 min. Charged $285 parts + labor. Tom very happy. Asked about annual service plan.",
    'answered', daysAgo(7));

  // ── Emails ────────────────────────────────────────────────────────────────────
  const insertEmail = db.prepare(`
    INSERT INTO emails
      (user_id, phone, direction, from_address, to_address, subject, body_preview,
       status, is_read, is_archived, is_deleted, mailbox, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `);

  insertEmail.run(userId, '+15559034712', 'inbound',
    'dreyes.home@gmail.com', 'you@plumblineleads.com',
    'Bathroom Renovation Quote',
    "Hi, could you send the written quote so my wife and I can look it over this weekend? Does your quote include tile work or just the plumbing?",
    'received', 0, 'inbox', daysAgo(2));

  insertEmail.run(userId, '+15559034712', 'outbound',
    'you@plumblineleads.com', 'dreyes.home@gmail.com',
    'Re: Bathroom Renovation Quote',
    "Hi David, attached is the full written quote. Range is $12,500–$16,000 depending on tile — tile is included. Valid for 30 days. Happy to answer any questions!",
    'sent', 1, 'sent', daysAgo(2));

  insertEmail.run(userId, '+15552348876', 'inbound',
    'mchen.home@outlook.com', 'you@plumblineleads.com',
    'Re: Tankless Water Heater Quote',
    "Quick question — does the $2,100 include the permit fee? Also what's the warranty on the Rinnai? My wife wants to know before we pull the trigger.",
    'received', 0, 'inbox', daysAgo(4));

  insertEmail.run(userId, '+15559014455', 'inbound',
    'dave@democonstruction.com', 'you@plumblineleads.com',
    'Re: HVAC Inspection — 3300 Industrial Park',
    "The quote looks good. Can you confirm the report will include photos for our lender? Do you have availability the week of the 20th?",
    'received', 0, 'inbox', daysAgo(3));

  // ── Messages (SMS) ─────────────────────────────────────────────────────────────
  const insertMessage = db.prepare(`
    INSERT INTO messages (user_id, phone, direction, body, status, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertMessage.run(userId, '+15558472391', 'inbound',  "Hi! Just got your voicemail. Thursday 2–4pm works great, thank you!", 'received',  1, daysAgo(0));
  insertMessage.run(userId, '+15558472391', 'outbound', "Perfect! We'll head over Thursday around 2. I'll text when we're 20 min out.", 'delivered', 1, daysAgo(0));
  insertMessage.run(userId, '+15554812903', 'inbound',  "Any chance someone can come TODAY? It's 85 in here and I have two little kids.", 'received',  0, daysAgo(2));
  insertMessage.run(userId, '+15554812903', 'outbound', "Hi Jennifer, I hear you. We're fully booked today but I can have someone there first thing tomorrow at 8am — will that work?", 'delivered', 0, daysAgo(2));
  insertMessage.run(userId, '+15552348876', 'inbound',  "Still thinking about the tankless quote. Can you send the itemized breakdown?", 'received',  0, daysAgo(4));

  const totalLeads = leads.length;
  console.log(`[Seed] Demo data seeded for user ${userId}: ${CONTACTS.length} contacts, ${totalLeads} leads, 6 calls, 4 emails, 5 messages`);
}

module.exports = { seedDemoData };

// ── Run directly (local DB only) ───────────────────────────────────────────────
if (require.main === module) {
  const userId = parseInt(process.argv[2], 10);
  if (!userId || isNaN(userId)) {
    console.error('Usage: node scripts/seed-demo.js <userId>');
    console.error('NOTE: seeds local DB only. Use POST /api/admin/reset-demo for production.');
    process.exit(1);
  }
  try {
    seedDemoData(userId);
    console.log('Done.');
  } catch (err) {
    console.error('Seed error:', err.message);
    process.exit(1);
  }
  process.exit(0);
}
