import Stripe from "stripe";
import { q } from "./db.js";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER,
  pro: process.env.STRIPE_PRICE_PRO,
  agency: process.env.STRIPE_PRICE_AGENCY,
};

export function billingEnabled() {
  return !!stripe;
}

/** Create a Stripe Checkout session for a plan upgrade. */
export async function createCheckout(tenant, plan, baseUrl) {
  if (!stripe) throw new Error("Billing is not configured (set STRIPE_SECRET_KEY)");
  const price = PRICE_IDS[plan];
  if (!price) throw new Error(`Unknown plan: ${plan}`);

  let customerId = tenant.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: tenant.email,
      metadata: { tenant_id: tenant.id },
    });
    customerId = customer.id;
    q.setStripeCustomer.run(customerId, tenant.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    success_url: `${baseUrl}/?billing=success`,
    cancel_url: `${baseUrl}/?billing=cancelled`,
    metadata: { tenant_id: tenant.id, plan },
    subscription_data: { metadata: { tenant_id: tenant.id, plan } },
  });
  return session.url;
}

/** Stripe customer portal so customers can manage/cancel themselves. */
export async function createPortal(tenant, baseUrl) {
  if (!stripe) throw new Error("Billing is not configured");
  if (!tenant.stripe_customer_id) throw new Error("No billing account yet");
  const session = await stripe.billingPortal.sessions.create({
    customer: tenant.stripe_customer_id,
    return_url: `${baseUrl}/`,
  });
  return session.url;
}

/** Express handler for the Stripe webhook. Mount with express.raw(). */
export function webhookHandler(req, res) {
  if (!stripe) return res.status(400).send("Billing not configured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook signature failed: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const tenantId = session.metadata?.tenant_id;
        const plan = session.metadata?.plan;
        if (tenantId && plan) {
          q.setPlan.run(plan, session.subscription || null, tenantId);
          q.setStatus.run("active", tenantId);
          console.log(`[billing] ${tenantId} upgraded to ${plan}`);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const tenantId = sub.metadata?.tenant_id;
        const tenant = tenantId
          ? q.tenantById.get(tenantId)
          : q.tenantByStripeCustomer.get(sub.customer);
        if (tenant) {
          q.setPlan.run("trial", null, tenant.id); // back to (expired) trial = automation off
          console.log(`[billing] ${tenant.id} subscription cancelled`);
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const tenant = q.tenantByStripeCustomer.get(invoice.customer);
        if (tenant) {
          q.setStatus.run("past_due", tenant.id);
          console.log(`[billing] ${tenant.id} payment failed`);
        }
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object;
        const tenant = q.tenantByStripeCustomer.get(invoice.customer);
        if (tenant && tenant.status === "past_due") {
          q.setStatus.run("active", tenant.id);
        }
        break;
      }
    }
  } catch (err) {
    console.error("[billing] webhook handling error:", err.message);
  }
  res.json({ received: true });
}
