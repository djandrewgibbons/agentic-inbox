// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Catch-all routing: which mailbox gets mail for an address that has no
 * mailbox of its own.
 *
 * CATCH_ALL_MAILBOX is a comma-separated list. `domain=mailbox` entries
 * route one domain; a bare `mailbox` entry is the default for the rest:
 *
 *   1119hillside.com=property@1119hillside.com, agp.us=sunfyre@agp.us, sunfyre@dxnd.us
 */

export interface CatchAllConfig {
	/** Recipient domain -> mailbox. */
	domains: Record<string, string>;
	/** Mailbox for domains without an entry. */
	fallback?: string;
	/** Entries that could not be read. */
	errors: string[];
}

export function parseCatchAll(raw: string | undefined): CatchAllConfig {
	const config: CatchAllConfig = { domains: {}, errors: [] };
	for (const entry of (raw || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)) {
		const parts = entry.split("=").map((p) => p.trim());
		const mailbox = parts[parts.length - 1];
		if (parts.length > 2 || !/^[^@\s]+@[^@\s]+$/.test(mailbox)) {
			config.errors.push(entry);
		} else if (parts.length === 1) {
			if (config.fallback) config.errors.push(entry);
			else config.fallback = mailbox;
		} else {
			const domain = parts[0].replace(/^@/, "");
			if (!domain || domain.includes("@") || config.domains[domain]) config.errors.push(entry);
			else config.domains[domain] = mailbox;
		}
	}
	return config;
}

/**
 * Pick the catch-all mailbox for a message. `recipients` is in priority
 * order (envelope recipient first); the first one whose domain has an
 * entry wins, otherwise the default applies.
 */
export function resolveCatchAll(config: CatchAllConfig, recipients: string[]): string | undefined {
	for (const address of recipients) {
		const mailbox = config.domains[address.slice(address.lastIndexOf("@") + 1).toLowerCase()];
		if (mailbox) return mailbox;
	}
	return config.fallback;
}
