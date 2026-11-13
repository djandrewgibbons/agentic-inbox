// Run with: npm test  (node --test, no extra dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	classifyByRules,
	parseRules,
	planTriage,
	matchPattern,
	COLD_OUTREACH_HINTS,
	type TriageInput,
	type TriageResult,
} from "../shared/triage.ts";

const input = (over: Partial<TriageInput>): TriageInput => ({
	from: "someone@example.com",
	to: "andrew@example.com",
	subject: "",
	text: "",
	headers: {},
	...over,
});

const rdrp = input({
	from: "noreply@registrar.amazon",
	to: "hostmaster@siliconechelon.com",
	subject: "[Action May Be Required] Confirm that contact information for sendachshund.com is correct",
	text: "This message is a reminder to help you keep the contact information for your domain registration up to date. If your information is accurate, you do not need to take any action.",
});

const pitch = input({
	from: "helenc@technovaapps.com",
	to: "bookings@djandrewgibbons.us",
	subject: "Hello - www.djandrewgibbons.us",
	text: "Hello, We create modern Android and iOS apps tailored to business needs. Let me know if you'd like to see our portfolio and packages. Thanks., Helen",
});

test("Route 53 RDRP reminder is admin, not action-required, and gets archived", () => {
	const r = classifyByRules(rdrp)!;
	assert.equal(r.category, "admin");
	assert.equal(r.source, "builtin");
	assert.equal(r.actionRequired, false);
	const plan = planTriage(r, undefined, { knownCorrespondent: false });
	assert.deepEqual(plan, { folder: "archive", markRead: true, star: false, draft: false, forward: false });
});

test("registrar verification / expiry mail stays in inbox and is starred", () => {
	const r = classifyByRules({ ...rdrp, subject: "Verify your email address for sendachshund.com" })!;
	assert.equal(r.actionRequired, true);
	const plan = planTriage(r, undefined, { knownCorrespondent: false });
	assert.equal(plan.folder, "inbox");
	assert.equal(plan.star, true);
	assert.equal(plan.draft, false);
});

test("cold app-dev pitch falls through to AI, with a sales hint", () => {
	assert.equal(classifyByRules(pitch), null);
	assert.ok(COLD_OUTREACH_HINTS.test(pitch.text));
});

test("AI cold_outreach result is archived without a draft", () => {
	const r: TriageResult = { category: "cold_outreach", source: "ai", confidence: 0.92, actionRequired: false, reason: "sales pitch" };
	assert.deepEqual(planTriage(r, undefined, { knownCorrespondent: false }), { folder: "archive", markRead: true, star: false, draft: false, forward: false });
});

test("low-confidence AI result is left in the inbox", () => {
	const r: TriageResult = { category: "cold_outreach", source: "ai", confidence: 0.4, actionRequired: false, reason: "?" };
	assert.equal(planTriage(r, undefined, { knownCorrespondent: false }).folder, "inbox");
});

test("people you have written to are never auto-filed by AI", () => {
	const r: TriageResult = { category: "cold_outreach", source: "ai", confidence: 0.95, actionRequired: false, reason: "" };
	assert.equal(planTriage(r, undefined, { knownCorrespondent: true }).folder, "inbox");
});

test("needs_reply gets a draft; draft categories are configurable", () => {
	const r: TriageResult = { category: "needs_reply", source: "ai", confidence: 0.9, actionRequired: false, reason: "" };
	assert.equal(planTriage(r, undefined, { knownCorrespondent: false }).draft, true);
	assert.equal(planTriage(r, { draftCategories: [] }, { knownCorrespondent: false }).draft, false);
});

test("bulk headers mean newsletter; no-reply senders mean notification", () => {
	assert.equal(classifyByRules(input({ headers: { "list-unsubscribe": "<mailto:x@y>" } }))!.category, "newsletter");
	assert.equal(classifyByRules(input({ from: "no-reply@shop.example" }))!.category, "notification");
	assert.equal(classifyByRules(input({ headers: { "auto-submitted": "auto-generated" } }))!.category, "notification");
});

test("user rules win over built-ins and can set an action", () => {
	const { rules, errors } = parseRules(`
# comment
from:@registrar.amazon subject:"contact information" => fyi inbox
to:bookings@ body:/portfolio|packages/ => cold_outreach trash
`);
	assert.deepEqual(errors, []);
	assert.equal(rules.length, 2);
	const r = classifyByRules(rdrp, rules)!;
	assert.equal(r.source, "rule");
	assert.equal(r.category, "fyi");
	const p = classifyByRules(pitch, rules)!;
	assert.equal(p.category, "cold_outreach");
	assert.equal(planTriage(p, undefined, { knownCorrespondent: true }).folder, "trash");
});

test("parseRules reports bad lines", () => {
	const { rules, errors } = parseRules("from:x => nope\nfoo => spam\nsubject:hi\nto:a@b => spam bin");
	assert.equal(rules.length, 0);
	assert.equal(errors.length, 4);
});

test("matchPattern: substring, wildcard, regex", () => {
	assert.ok(matchPattern("@Registrar.amazon", "noreply@registrar.amazon"));
	assert.ok(matchPattern("*@*.registrar.amazon", "x@mail.registrar.amazon"));
	assert.ok(matchPattern("/^hello\\b/", "Hello - www.djandrewgibbons.us"));
	assert.ok(!matchPattern("/[unclosed/", "anything"));
});

test("forwarding: off without an address, then by category and urgency", () => {
	const reply: TriageResult = { category: "needs_reply", source: "ai", confidence: 0.9, actionRequired: false, reason: "" };
	const ctx = { knownCorrespondent: false };
	assert.equal(planTriage(reply, undefined, ctx).forward, false);
	assert.equal(planTriage(reply, { forwardTo: "not an address" }, ctx).forward, false);
	assert.equal(planTriage(reply, { forwardTo: "me@example.com" }, ctx).forward, true);
	assert.equal(planTriage(reply, { forwardTo: "me@example.com", forwardCategories: [] }, ctx).forward, false);

	const routine = classifyByRules(rdrp)!;
	assert.equal(planTriage(routine, { forwardTo: "me@example.com" }, ctx).forward, false);
	const urgent = classifyByRules({ ...rdrp, subject: "Verify your email address for sendachshund.com" })!;
	assert.equal(planTriage(urgent, { forwardTo: "me@example.com" }, ctx).forward, true);
	assert.equal(planTriage(urgent, { forwardTo: "me@example.com", forwardUrgent: false }, ctx).forward, false);
});
