/**
 * Inbound mail triage: categories, default actions, and the deterministic
 * rule engine. Pure TypeScript with no runtime imports so it can be shared
 * by the worker, the UI, and `node --test`.
 *
 * Order of evaluation for a new email:
 *   1. Mailbox rules the user wrote (settings.triage.rules)
 *   2. Built-in sender rules (registrars, cloud providers, etc.)
 *   3. Header heuristics (Auto-Submitted, List-Unsubscribe, Precedence)
 *   4. LLM classifier (workers/lib/triage.ts), only if nothing above matched
 */

export const TRIAGE_CATEGORIES = [
	"needs_reply",
	"fyi",
	"admin",
	"notification",
	"newsletter",
	"cold_outreach",
	"spam",
] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export const TRIAGE_ACTIONS = ["inbox", "archive", "spam", "trash"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export type TriageSource = "rule" | "builtin" | "headers" | "ai" | "fallback";

export const TRIAGE_LABELS: Record<TriageCategory, string> = {
	needs_reply: "Needs reply",
	fyi: "FYI",
	admin: "Admin",
	notification: "Notification",
	newsletter: "Newsletter",
	cold_outreach: "Cold outreach",
	spam: "Spam",
};

export const TRIAGE_DESCRIPTIONS: Record<TriageCategory, string> = {
	needs_reply: "A real person wrote to you and expects an answer: inquiries, bookings, clients, friends.",
	fyi: "A real person, but no reply is needed: thanks, confirmations, CCs.",
	admin: "Account, domain, billing, legal or security notices from a service you use.",
	notification: "Automated receipts, alerts, shipping updates, system mail.",
	newsletter: "Bulk mail you subscribed to: newsletters, marketing, digests.",
	cold_outreach: "Unsolicited sales or service pitches, SEO, link building, app/dev agencies.",
	spam: "Scams, phishing, junk.",
};

/** What happens to each category when no override is configured. */
export const DEFAULT_TRIAGE_ACTIONS: Record<TriageCategory, TriageAction> = {
	needs_reply: "inbox",
	fyi: "inbox",
	admin: "archive", // admin mail flagged action_required stays in the inbox
	notification: "archive",
	newsletter: "archive",
	cold_outreach: "archive",
	spam: "spam",
};

/** Categories the agent drafts a reply for. Drafts are never sent automatically. */
export const DEFAULT_DRAFT_CATEGORIES: TriageCategory[] = ["needs_reply"];

/** Categories copied to the forward address once one is set. */
export const DEFAULT_FORWARD_CATEGORIES: TriageCategory[] = ["needs_reply"];

export function isValidEmail(s: string | undefined): boolean {
	return !!s && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s.trim());
}

/** Below this AI confidence, mail stays in the inbox untouched. */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

export interface TriageRule {
	from?: string;
	to?: string;
	subject?: string;
	body?: string;
	category: TriageCategory;
	action?: TriageAction;
}

export interface TriageSettings {
	enabled?: boolean;
	useAI?: boolean;
	minConfidence?: number;
	actions?: Partial<Record<TriageCategory, TriageAction>>;
	draftCategories?: TriageCategory[];
	/** One rule per line, see parseRules(). */
	rules?: string;
	/** Address that gets a copy of matching mail. Empty = no forwarding. */
	forwardTo?: string;
	forwardCategories?: TriageCategory[];
	/** Also forward anything flagged action-required, whatever its category. */
	forwardUrgent?: boolean;
}

export interface TriageInput {
	from: string;
	to: string;
	subject: string;
	/** Plain text body. */
	text: string;
	/** Lower-cased header names. */
	headers: Record<string, string>;
}

export interface TriageResult {
	category: TriageCategory;
	source: TriageSource;
	confidence: number;
	actionRequired: boolean;
	reason: string;
	summary?: string;
	/** Explicit action from a user rule; overrides the category default. */
	action?: TriageAction;
}

export interface TriagePlan {
	folder: TriageAction;
	markRead: boolean;
	star: boolean;
	draft: boolean;
	/** Send a copy to settings.forwardTo. */
	forward: boolean;
}

// ── Pattern matching ───────────────────────────────────────────────

/**
 * `/regex/flags` is a regular expression; anything else is a
 * case-insensitive substring, where `*` matches any run of characters.
 */
export function matchPattern(pattern: string, value: string): boolean {
	const p = pattern.trim();
	if (!p) return false;
	const re = p.match(/^\/(.+)\/([a-z]*)$/);
	if (re) {
		try {
			return new RegExp(re[1], re[2].includes("i") ? re[2] : `${re[2]}i`).test(value);
		} catch {
			return false;
		}
	}
	if (p.includes("*")) {
		const escaped = p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
		return new RegExp(escaped, "i").test(value);
	}
	return value.toLowerCase().includes(p.toLowerCase());
}

export function ruleMatches(rule: TriageRule, input: TriageInput): boolean {
	const checks: [string | undefined, string][] = [
		[rule.from, input.from],
		[rule.to, input.to],
		[rule.subject, input.subject],
		[rule.body, input.text],
	];
	const active = checks.filter(([p]) => p !== undefined);
	return active.length > 0 && active.every(([p, v]) => matchPattern(p!, v));
}

// ── Rule DSL ───────────────────────────────────────────────────────

/**
 * Parse mailbox rules, one per line:
 *
 *   from:@registrar.amazon => admin
 *   to:bookings@ subject:"app development" => cold_outreach archive
 *   from:/@(mailchimp|substack)\./ => newsletter
 *
 * Fields: from, to, subject, body. Values with spaces go in double quotes.
 * Blank lines and lines starting with # are ignored. Invalid lines are
 * reported in `errors` and skipped.
 */
export function parseRules(text: string | undefined): { rules: TriageRule[]; errors: string[] } {
	const rules: TriageRule[] = [];
	const errors: string[] = [];
	if (!text) return { rules, errors };

	text.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.trim();
		if (!line || line.startsWith("#")) return;
		const [lhs, rhs] = line.split("=>").map((s) => s?.trim());
		if (!lhs || !rhs) {
			errors.push(`Line ${i + 1}: expected "<conditions> => <category> [action]"`);
			return;
		}
		const [category, action] = rhs.split(/\s+/);
		if (!TRIAGE_CATEGORIES.includes(category as TriageCategory)) {
			errors.push(`Line ${i + 1}: unknown category "${category}"`);
			return;
		}
		if (action && !TRIAGE_ACTIONS.includes(action as TriageAction)) {
			errors.push(`Line ${i + 1}: unknown action "${action}"`);
			return;
		}
		const rule: TriageRule = { category: category as TriageCategory };
		if (action) rule.action = action as TriageAction;

		const condRe = /(from|to|subject|body):("([^"]*)"|\S+)/g;
		let m: RegExpExecArray | null;
		let consumed = lhs;
		while ((m = condRe.exec(lhs))) {
			const field = m[1] as "from" | "to" | "subject" | "body";
			rule[field] = m[3] ?? m[2];
			consumed = consumed.replace(m[0], "");
		}
		if (consumed.trim()) {
			errors.push(`Line ${i + 1}: could not read "${consumed.trim()}"`);
			return;
		}
		if (!rule.from && !rule.to && !rule.subject && !rule.body) {
			errors.push(`Line ${i + 1}: needs at least one of from:, to:, subject:, body:`);
			return;
		}
		rules.push(rule);
	});
	return { rules, errors };
}

// ── Built-in knowledge ─────────────────────────────────────────────

/** Sender domains (and their subdomains) whose mail is account/domain/billing admin. */
const ADMIN_DOMAINS: string[] = [
	"registrar.amazon",
	"amazonaws.com",
	"aws.amazon.com",
	"notify.cloudflare.com",
	"namecheap.com",
	"godaddy.com",
	"squarespace.com",
	"accounts.google.com",
	"icann.org",
	"stripe.com",
	"id.apple.com",
	"email.apple.com",
];

export function senderDomain(address: string): string {
	return (address.split("@")[1] || "").toLowerCase().trim();
}

function domainIn(domain: string, list: string[]): string | undefined {
	return list.find((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Subjects that mean "act or lose something" even from an admin sender. */
const ACTION_REQUIRED_SUBJECT =
	/(verify your (email|contact)|suspend|will expire|has expired|expir(es|ing) (soon|in|on)|renewal failed|payment (failed|declined)|past due|overdue|unauthori[sz]ed|security alert|new sign-?in|password (reset|changed)|transfer (request|authori[sz]ation)|final notice)/i;

/** Sales pitches. Used only as a hint for the AI and in tests; never alone. */
export const COLD_OUTREACH_HINTS =
	/(we (create|build|develop|design)|our (portfolio|packages|services)|let me know if you'?d like to see|seo|backlinks?|guest post|rank (higher|on google)|app development|web ?design|outsourc|lead generation|book a (quick )?call|15[- ]minute call)/i;

/** Placeholder senders that never take replies. */
const NO_REPLY_SENDER = /^(no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|postmaster|bounce)[@+.-]/i;

function header(h: Record<string, string>, name: string): string {
	return (h[name] || "").toLowerCase();
}

/**
 * Deterministic classification. Returns null when the AI should decide.
 */
export function classifyByRules(input: TriageInput, userRules: TriageRule[] = []): TriageResult | null {
	const from = input.from.toLowerCase();

	for (const rule of userRules) {
		if (ruleMatches(rule, input)) {
			return {
				category: rule.category,
				source: "rule",
				confidence: 1,
				actionRequired: false,
				reason: `Matched your rule ${describeRule(rule)}`,
				action: rule.action,
			};
		}
	}

	const adminSender = domainIn(senderDomain(from), ADMIN_DOMAINS);
	if (adminSender) {
		const actionRequired = ACTION_REQUIRED_SUBJECT.test(input.subject);
		return {
			category: "admin",
			source: "builtin",
			confidence: 0.9,
			actionRequired,
			reason: actionRequired
				? `Account notice from ${adminSender} that looks time-sensitive`
				: `Account notice from ${adminSender}`,
		};
	}

	const autoSubmitted = header(input.headers, "auto-submitted");
	const precedence = header(input.headers, "precedence");
	const listUnsub = header(input.headers, "list-unsubscribe");
	const listId = header(input.headers, "list-id");

	if (listUnsub || listId || precedence === "bulk" || precedence === "list") {
		return {
			category: "newsletter",
			source: "headers",
			confidence: 0.85,
			actionRequired: false,
			reason: "Bulk mail (has List-Unsubscribe / List-Id / Precedence: bulk)",
		};
	}

	if ((autoSubmitted && autoSubmitted !== "no") || NO_REPLY_SENDER.test(from)) {
		const actionRequired = ACTION_REQUIRED_SUBJECT.test(input.subject);
		return {
			category: actionRequired ? "admin" : "notification",
			source: "headers",
			confidence: 0.8,
			actionRequired,
			reason: autoSubmitted ? `Automated mail (Auto-Submitted: ${autoSubmitted})` : "Sent from a no-reply address",
		};
	}

	return null;
}

function describeRule(rule: TriageRule): string {
	return (["from", "to", "subject", "body"] as const)
		.filter((k) => rule[k])
		.map((k) => `${k}:${rule[k]}`)
		.join(" ");
}

// ── Planning ───────────────────────────────────────────────────────

export interface PlanContext {
	/** The mailbox has sent mail to this sender or in this thread before. */
	knownCorrespondent: boolean;
}

/**
 * Turn a classification into concrete actions. Safety rails:
 *  - Low-confidence AI results never move mail.
 *  - Mail from people you've written to never leaves the inbox automatically.
 *  - Admin mail that looks time-sensitive stays in the inbox, starred.
 */
export function planTriage(result: TriageResult, settings: TriageSettings | undefined, ctx: PlanContext): TriagePlan {
	const actions = { ...DEFAULT_TRIAGE_ACTIONS, ...(settings?.actions || {}) };
	const draftCategories = settings?.draftCategories ?? DEFAULT_DRAFT_CATEGORIES;
	const minConfidence = settings?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

	let folder: TriageAction = result.action ?? actions[result.category];

	if (result.source === "ai" && result.confidence < minConfidence) folder = "inbox";
	if (result.actionRequired) folder = "inbox";
	if (ctx.knownCorrespondent && result.source !== "rule" && folder !== "inbox") folder = "inbox";

	const forwardCategories = settings?.forwardCategories ?? DEFAULT_FORWARD_CATEGORIES;
	const forward =
		isValidEmail(settings?.forwardTo) &&
		(forwardCategories.includes(result.category) || (result.actionRequired && settings?.forwardUrgent !== false));

	return {
		folder,
		markRead: folder !== "inbox",
		star: result.actionRequired,
		draft: folder === "inbox" && draftCategories.includes(result.category),
		forward,
	};
}

/** Settings with defaults filled in, for the UI. */
export function resolveTriageSettings(s: TriageSettings | undefined): Required<TriageSettings> {
	return {
		enabled: s?.enabled ?? true,
		useAI: s?.useAI ?? true,
		minConfidence: s?.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
		actions: { ...DEFAULT_TRIAGE_ACTIONS, ...(s?.actions || {}) },
		draftCategories: s?.draftCategories ?? DEFAULT_DRAFT_CATEGORIES,
		rules: s?.rules ?? "",
		forwardTo: s?.forwardTo ?? "",
		forwardCategories: s?.forwardCategories ?? DEFAULT_FORWARD_CATEGORIES,
		forwardUrgent: s?.forwardUrgent ?? true,
	};
}
