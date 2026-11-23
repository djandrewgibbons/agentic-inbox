// Run with: npm test  (node --test, no extra dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCatchAll, resolveCatchAll } from "../shared/routing.ts";

const config = parseCatchAll(
	"1119hillside.com=property@1119hillside.com, agp.us=sunfyre@agp.us, AndrewGibbonsProductions.us = Sunfyre@agp.us, sunfyre@dxnd.us",
);

test("parses domain entries and a default", () => {
	assert.deepEqual(config, {
		domains: {
			"1119hillside.com": "property@1119hillside.com",
			"agp.us": "sunfyre@agp.us",
			"andrewgibbonsproductions.us": "sunfyre@agp.us",
		},
		fallback: "sunfyre@dxnd.us",
		errors: [],
	});
});

test("a single address is the default for every domain", () => {
	const single = parseCatchAll(" Mail@dxnd.us ");
	assert.deepEqual(single, { domains: {}, fallback: "mail@dxnd.us", errors: [] });
	assert.equal(resolveCatchAll(single, ["x@anything.com"]), "mail@dxnd.us");
	assert.equal(resolveCatchAll(parseCatchAll(""), ["x@anything.com"]), undefined);
	assert.equal(resolveCatchAll(parseCatchAll(undefined), ["x@anything.com"]), undefined);
});

test("routes by recipient domain, then the default", () => {
	assert.equal(resolveCatchAll(config, ["leasing@1119hillside.com"]), "property@1119hillside.com");
	assert.equal(resolveCatchAll(config, ["Info@AGP.us"]), "sunfyre@agp.us");
	assert.equal(resolveCatchAll(config, ["hi@andrewgibbonsproductions.us"]), "sunfyre@agp.us");
	assert.equal(resolveCatchAll(config, ["hostmaster@siliconechelon.com"]), "sunfyre@dxnd.us");
	// Subdomains are separate domains.
	assert.equal(resolveCatchAll(config, ["a@mail.agp.us"]), "sunfyre@dxnd.us");
});

test("the first recipient with a domain entry wins", () => {
	assert.equal(resolveCatchAll(config, ["a@siliconechelon.com", "b@agp.us", "c@1119hillside.com"]), "sunfyre@agp.us");
});

test("reports entries it cannot read", () => {
	const bad = parseCatchAll("agp.us=nope, a=b=c@d.us, one@x.us, two@x.us, agp.us=a@agp.us, agp.us=b@agp.us, =c@x.us");
	assert.deepEqual(bad.errors, ["agp.us=nope", "a=b=c@d.us", "two@x.us", "agp.us=b@agp.us", "=c@x.us"]);
	assert.deepEqual(bad.domains, { "agp.us": "a@agp.us" });
	assert.equal(bad.fallback, "one@x.us");
});
