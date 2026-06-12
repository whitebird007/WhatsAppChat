/* Industry starter packs — one-click prebuilt agent + templates + auto-replies */
import { q } from "./db.js";

export const STARTER_PACKS = [
  {
    id: "real_estate", name: "Real Estate", emoji: "🏠",
    description: "Qualify property leads, share listings, and book viewings.",
    agent: {
      name: "Property Assistant", emoji: "🏠",
      instructions: "You are a friendly real-estate assistant. Help customers find properties, answer questions about listings, and book viewings. Always ask for budget, preferred area, and number of bedrooms early. Be warm and professional.",
      playbook: "1. Greet the customer\n2. Ask what they're looking for (buy/rent, area, budget, bedrooms)\n3. Recommend matching options\n4. Offer to book a viewing\n5. Capture their name and best time to call",
      rules: "Never promise a price or availability without confirming with the agent. If asked something you can't answer, say a property advisor will follow up shortly.",
    },
    templates: [
      { name: "Listing details", shortcut: "/listing", body: "Here are the details for that property 🏠\n\n📍 Location: \n🛏 Bedrooms: \n💰 Price: \n\nWould you like to book a viewing?" },
      { name: "Book a viewing", shortcut: "/viewing", body: "I'd love to arrange a viewing for you! What day and time works best this week?" },
      { name: "Budget check", shortcut: "/budget", body: "To find the best options for you, may I ask your budget range and preferred area?" },
    ],
    rules: [
      { keyword: "viewing", reply: "Of course! What day and time suits you for a viewing? I'll get it booked.", match_type: "contains" },
      { keyword: "price", reply: "Happy to help with pricing. Which property are you interested in?", match_type: "contains" },
    ],
  },
  {
    id: "salon", name: "Salon & Spa", emoji: "💇",
    description: "Take bookings, share services & prices, and reduce no-shows.",
    agent: {
      name: "Booking Assistant", emoji: "💇",
      instructions: "You are a warm, friendly salon booking assistant. Help customers book appointments, share the service menu and prices, and confirm details. Always confirm date, time, and service.",
      playbook: "1. Greet warmly\n2. Ask which service they'd like\n3. Offer available times\n4. Confirm the booking details\n5. Send a friendly confirmation",
      rules: "Do not double-book. If unsure about availability, say the front desk will confirm shortly.",
    },
    templates: [
      { name: "Service menu", shortcut: "/menu", body: "Here's our service menu ✨\n\n💇 Haircut – \n💅 Manicure – \n💆 Facial – \n\nWhich would you like to book?" },
      { name: "Confirm booking", shortcut: "/confirm", body: "You're all set, {{first_name}}! ✅\n\n📅 \n🕐 \n💇 Service: \n\nSee you then! Reply CHANGE if you need to reschedule." },
    ],
    rules: [
      { keyword: "book", reply: "I'd be happy to book you in! Which service would you like, and what day works best?", match_type: "contains" },
      { keyword: "price", reply: "Here's our price list ✨ — which service are you interested in?", match_type: "contains" },
    ],
  },
  {
    id: "ecommerce", name: "E-commerce Store", emoji: "🛍",
    description: "Answer product questions, track orders, and recover carts.",
    agent: {
      name: "Shop Assistant", emoji: "🛍",
      instructions: "You are a helpful online store assistant. Answer product questions, help customers choose, share shipping/return info, and help with orders. Be upbeat and encourage purchases without being pushy.",
      playbook: "1. Greet the shopper\n2. Understand what they're looking for\n3. Recommend products\n4. Answer shipping/returns questions\n5. Help them complete the order",
      rules: "Never invent stock levels or delivery dates. For order issues, collect the order number and say the team will check.",
    },
    templates: [
      { name: "Shipping info", shortcut: "/shipping", body: "📦 Shipping is 2–4 business days. Free over $50! Want me to help you place an order?" },
      { name: "Order status", shortcut: "/order", body: "Happy to check! What's your order number? I'll look it up for you." },
      { name: "Discount", shortcut: "/discount", body: "Here's a little something 🎁 Use code WELCOME10 for 10% off your first order!" },
    ],
    rules: [
      { keyword: "shipping", reply: "📦 We ship in 2–4 business days, free over $50. Anything you'd like to order?", match_type: "contains" },
      { keyword: "refund", reply: "No worries — we offer easy returns within 14 days. Can you share your order number?", match_type: "contains" },
    ],
  },
  {
    id: "restaurant", name: "Restaurant", emoji: "🍽",
    description: "Take reservations, share the menu, and handle takeaway orders.",
    agent: {
      name: "Reservations Assistant", emoji: "🍽",
      instructions: "You are a friendly restaurant assistant. Help guests reserve tables, share the menu, opening hours, and take takeaway orders. Always confirm party size, date, and time for reservations.",
      playbook: "1. Greet the guest\n2. Ask: reservation or takeaway?\n3. For reservations: party size, date, time\n4. Confirm the details\n5. Thank them warmly",
      rules: "Confirm reservation details before finalizing. If fully booked, offer the nearest available time.",
    },
    templates: [
      { name: "Reserve a table", shortcut: "/reserve", body: "We'd love to have you! 🍽 How many guests, and what date & time?" },
      { name: "Opening hours", shortcut: "/hours", body: "🕐 We're open:\nMon–Fri: 12pm–11pm\nSat–Sun: 10am–11pm\n\nCan I book you a table?" },
    ],
    rules: [
      { keyword: "reservation", reply: "Of course! How many guests, and for what date and time? 🍽", match_type: "contains" },
      { keyword: "menu", reply: "Here's our menu 🍽 — would you like to reserve a table or order takeaway?", match_type: "contains" },
    ],
  },
  {
    id: "clinic", name: "Clinic & Healthcare", emoji: "🩺",
    description: "Book appointments, share clinic info, and send reminders.",
    agent: {
      name: "Clinic Assistant", emoji: "🩺",
      instructions: "You are a calm, caring clinic assistant. Help patients book appointments, share opening hours and services, and answer general questions. Be reassuring and never give specific medical advice — direct medical questions to the doctor.",
      playbook: "1. Greet warmly and reassuringly\n2. Ask what they need (appointment, info)\n3. For appointments: ask preferred date/time and reason\n4. Confirm the booking\n5. Remind them what to bring",
      rules: "Never provide a diagnosis or medical advice. For anything clinical, say the doctor will advise during the appointment. For emergencies, advise calling emergency services.",
    },
    templates: [
      { name: "Book appointment", shortcut: "/appointment", body: "I can help you book an appointment 🩺 What day and time would you prefer, and may I ask the reason for your visit?" },
      { name: "Clinic info", shortcut: "/info", body: "🏥 We're open Mon–Sat, 9am–6pm.\n📍 \n📞 \n\nWould you like to book an appointment?" },
    ],
    rules: [
      { keyword: "appointment", reply: "Happy to help you book 🩺 What day and time works best for you?", match_type: "contains" },
    ],
  },
];

export function packSummary() {
  return STARTER_PACKS.map((p) => ({
    id: p.id, name: p.name, emoji: p.emoji, description: p.description,
    agent: p.agent.name, templates: p.templates.length, rules: p.rules.length,
  }));
}

export function installPack(tenantId, packId) {
  const pack = STARTER_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error("Unknown pack");
  const a = pack.agent;
  q.addAgent.run(tenantId, a.name, a.emoji, a.instructions, a.playbook, a.rules, "gpt-4o-mini", "", Date.now());
  for (const t of pack.templates) q.addTemplate.run(tenantId, t.name, t.shortcut, t.body);
  for (const r of pack.rules) q.addRule.run(tenantId, r.keyword, r.reply, r.match_type);
  return { agent: 1, templates: pack.templates.length, rules: pack.rules.length };
}
