#!/usr/bin/env node
/**
 * Demo data seed — creates realistic fake records for the demo user account.
 *
 * Exported as a module so /api/admin/reset-demo can call seedDemoData(userId).
 * Also runnable directly:
 *
 *   node scripts/seed-demo.js <userId>
 *
 * The reset-demo route wipes all the demo user's data first, then calls this.
 * Running this directly without wiping first may hit UNIQUE constraint errors
 * on contacts if the same phone numbers already exist for that user.
 */
'use strict';

const db = require('../db');

/** Returns an ISO-ish datetime string N days before now (SQLite DATETIME format). */
function daysAgo(n, hoursOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(d.getHours() - hoursOffset);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function seedDemoData(userId) {
  // ── Contacts ────────────────────────────────────────────────────────────────
  const insertContact = db.prepare(`
    INSERT OR IGNORE INTO contacts
      (user_id, phone, name, email, address_line_1, city, state, postal_code, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertContact.run(
    userId, '+15558472391', 'Sarah Johnson', 'sarah.johnson@gmail.com',
    '742 Evergreen Terrace', 'Springfield', 'IL', '62701',
    'Referred by Mike Chen. Faucet job completed Thursday.',
    daysAgo(7)
  );
  insertContact.run(
    userId, '+15552348876', 'Mike Chen', 'mchen.home@outlook.com',
    '1450 Oak Ridge Blvd', 'Riverside', 'IL', '60546',
    'Previous customer — water heater install 2022. Now looking at tankless upgrade.',
    daysAgo(5)
  );
  insertContact.run(
    userId, '+15556619034', 'Patricia Williams', 'p.williams@yahoo.com',
    '88 Maple Court', 'Westfield', 'IL', '62101',
    'Interested in full bathroom remodel later this year. Big upsell opportunity.',
    daysAgo(2)
  );

  // ── Leads ───────────────────────────────────────────────────────────────────
  const insertLead = db.prepare(`
    INSERT INTO leads
      (user_id, transcript, contact_name, company_name, phone_number, callback_number,
       summary, key_points, follow_up_text, category, status, source, archived, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);

  // Lead 1 — Sarah Johnson, leaky faucet, New
  insertLead.run(
    userId,
    "Hi this is Sarah Johnson calling. I've got a leaky kitchen faucet that's been dripping for about two weeks now and it's getting worse. I'm also seeing a little bit of water under the cabinet so I'm worried there might be more going on. I'm at 742 Evergreen Terrace in Springfield. My number is 555-847-2391. If someone could come out and take a look I'd really appreciate it. I'm pretty flexible on timing, any afternoon this week works.",
    'Sarah Johnson', null, '+15558472391', '+15558472391',
    'Sarah Johnson has a leaking kitchen faucet that has worsened over 2 weeks, with possible water damage visible under the cabinet. Flexible for afternoon visits.',
    JSON.stringify([
      'Leaky kitchen faucet, dripping for 2 weeks and worsening',
      'Water visible under cabinet — possible supply line or drain issue',
      'Location: 742 Evergreen Terrace, Springfield IL',
      'Available any afternoon this week',
    ]),
    'Call Sarah to schedule kitchen inspection. Check faucet and under-sink supply lines. Quote faucet replacement plus inspect cabinet for water damage.',
    'Lead', 'New', 'voicemail', daysAgo(7)
  );

  // Lead 2 — Mike Chen, water heater replacement, Contacted
  insertLead.run(
    userId,
    "Hey it's Mike Chen, I'm at 1450 Oak Ridge over in Riverside. My water heater is about 12 years old and I'm starting to get some rust-colored water in the mornings. I know it's probably time to replace it. Can you give me a call back to discuss options? I'm thinking I might want to go tankless this time around. My number is 555-234-8876.",
    'Mike Chen', null, '+15552348876', '+15552348876',
    'Mike Chen is experiencing rust-colored water from a 12-year-old water heater and wants to explore replacement options. Specifically interested in going tankless.',
    JSON.stringify([
      '12-year-old water heater producing rust-colored water',
      'Customer interested in tankless upgrade',
      'Location: 1450 Oak Ridge Blvd, Riverside IL',
      'Callback requested',
    ]),
    'Call Mike to discuss tankless vs traditional. Prepare quotes for both. Tankless typically $1,800–$2,400 depending on gas line work.',
    'Lead', 'Contacted', 'voicemail', daysAgo(5)
  );

  // Lead 3 — Demo Construction LLC, commercial HVAC, Quote Sent
  insertLead.run(
    userId,
    "This is Dave from Demo Construction LLC. We have a commercial property at 3300 Industrial Park Drive and we need a full HVAC inspection before we close on it next month. The building is about 8,000 square feet and the systems look like they haven't been serviced in several years. We'd need a detailed written report for our lender. Please call us back at 555-901-4455.",
    'Dave', 'Demo Construction LLC', '+15559014455', '+15559014455',
    'Commercial HVAC inspection needed for an 8,000 sq ft acquisition property at 3300 Industrial Park Drive. Detailed written report required by lender before closing.',
    JSON.stringify([
      'Commercial HVAC inspection — 8,000 sq ft property',
      'Systems appear neglected, no recent service records',
      'Written report with photos required for lender',
      'Closing deadline: next month',
    ]),
    'Send written quote for commercial inspection. Cover all rooftop units, ductwork, coils, filters, thermostats. Include photo report. Range: $600–$900.',
    'Commercial', 'Quote Sent', 'voicemail', daysAgo(3)
  );

  // Lead 4 — Patricia Williams, drain + bathroom remodel, Won
  insertLead.run(
    userId,
    "Hi, Patricia Williams here, 88 Maple Court in Westfield. I've got a slow drain in my master bathroom that's been backing up. I also noticed the toilet is running constantly. While you're here I'd love to get your thoughts on a bathroom remodel I'm planning — new vanity, new shower, the works. Number is 555-661-9034. Thanks.",
    'Patricia Williams', null, '+15556619034', '+15556619034',
    'Patricia Williams has a slow master bath drain and a constantly running toilet. Also wants a remodel consultation for new vanity and shower.',
    JSON.stringify([
      'Slow drain in master bathroom, backing up',
      'Toilet running constantly — likely flapper or fill valve',
      'Interested in full bathroom remodel: vanity, shower',
      'Location: 88 Maple Court, Westfield IL',
    ]),
    'Scheduled Thursday. Fix drain and toilet. Bring remodel portfolio — good upsell opportunity.',
    'Lead', 'Won', 'voicemail', daysAgo(2)
  );

  // ── Calls ───────────────────────────────────────────────────────────────────
  const insertCall = db.prepare(`
    INSERT INTO calls
      (user_id, from_number, call_sid, classification, status, duration,
       transcript, summary, key_points, contractor_note, outcome, is_seen, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  // Inbound voicemail from Sarah
  insertCall.run(
    userId, '+15558472391', 'CA_demo_001', 'new-lead', 'voicemail', 47,
    "Hi this is Sarah Johnson calling. I've got a leaky kitchen faucet that's been dripping for about two weeks now and it's getting worse. I'm also seeing a little bit of water under the cabinet...",
    'Voicemail from Sarah Johnson about a leaking kitchen faucet with possible water damage under the cabinet.',
    JSON.stringify(['Leaky faucet worsening 2+ weeks', 'Water under cabinet', 'Callback requested']),
    null, null, daysAgo(7)
  );

  // Missed inbound from Mike Chen
  insertCall.run(
    userId, '+15552348876', 'CA_demo_002', 'existing-customer', 'missed', 0,
    null, null, null, null, null, daysAgo(5)
  );

  // Outbound call to Mike — answered, contractor wrote a note
  insertCall.run(
    userId, '+15552348876', 'CA_demo_003', 'existing-customer', 'completed', 318,
    null, null, null,
    "Talked to Mike about water heater options. He wants to go tankless. Quoted $2,100 installed — includes running a new 3/4\" gas line stub from the basement. He's thinking it over and said he'll call back by end of week.",
    'answered', daysAgo(4, 2)
  );

  // Inbound voicemail from Patricia
  insertCall.run(
    userId, '+15556619034', 'CA_demo_004', 'new-lead', 'voicemail', 63,
    "Hi, Patricia Williams here, 88 Maple Court in Westfield. I've got a slow drain in my master bathroom that's been backing up. I also noticed the toilet is running constantly...",
    'Voicemail from Patricia Williams about a slow master bath drain, running toilet, and interest in a full bathroom remodel.',
    JSON.stringify(['Slow master bath drain', 'Running toilet', 'Bathroom remodel inquiry']),
    null, null, daysAgo(2)
  );

  // ── Emails ──────────────────────────────────────────────────────────────────
  const insertEmail = db.prepare(`
    INSERT INTO emails
      (user_id, phone, direction, from_address, to_address, subject, body_preview,
       status, is_read, is_archived, is_deleted, mailbox, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `);

  // Inbound from Sarah — unread
  insertEmail.run(
    userId, '+15558472391', 'inbound',
    'sarah.johnson@gmail.com', 'you@plumblineleads.com',
    'Re: Kitchen faucet repair',
    "Hi, just following up on my voicemail from yesterday. Any chance someone can come out Thursday or Friday afternoon? The dripping is really bad now and I can hear it from the living room.",
    'received', 0, 'inbox', daysAgo(6)
  );

  // Outbound reply to Sarah
  insertEmail.run(
    userId, '+15558472391', 'outbound',
    'you@plumblineleads.com', 'sarah.johnson@gmail.com',
    'Re: Kitchen faucet repair',
    "Hi Sarah, thanks for reaching out! We can absolutely come out Thursday between 2–4 PM. We'll assess the faucet and check under the cabinet for any water damage. See you then!",
    'sent', 1, 'sent', daysAgo(6)
  );

  // Inbound from Dave at Demo Construction — unread
  insertEmail.run(
    userId, '+15559014455', 'inbound',
    'dave@democonstructionllc.com', 'you@plumblineleads.com',
    'HVAC Inspection Quote — 3300 Industrial Park Dr',
    "Thanks for getting back to us. The quote looks reasonable. Can you confirm you'll provide a full written report with photos that we can submit to our lender? Also, do you have availability the week of the 20th?",
    'received', 0, 'inbox', daysAgo(1)
  );

  // ── Messages (SMS) ──────────────────────────────────────────────────────────
  const insertMessage = db.prepare(`
    INSERT INTO messages (user_id, phone, direction, body, status, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertMessage.run(userId, '+15558472391', 'inbound',  "Hi, it's Sarah. Just confirming Thursday 2–4pm works. Thanks!", 'received',  1, daysAgo(5));
  insertMessage.run(userId, '+15558472391', 'outbound', "Confirmed! See you Thursday. We'll call when we're 30 min out.",   'delivered', 1, daysAgo(5));
  insertMessage.run(userId, '+15552348876', 'inbound',  "Hey, still thinking about the tankless quote. Can you send me the written estimate?", 'received', 0, daysAgo(1));

  console.log(`[Seed] Demo data seeded for user ${userId}: 3 contacts, 4 leads, 4 calls, 3 emails, 3 messages`);
}

module.exports = { seedDemoData };

// ── Run directly ──────────────────────────────────────────────────────────────
// node scripts/seed-demo.js <userId>
if (require.main === module) {
  const userId = parseInt(process.argv[2], 10);
  if (!userId || isNaN(userId)) {
    console.error('Usage: node scripts/seed-demo.js <userId>');
    console.error('Find the demo user id with: sqlite3 leads.db "SELECT id, email FROM users;"');
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
