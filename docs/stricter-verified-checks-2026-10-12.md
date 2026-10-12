# Stricter verified checks — October 12, 2026

A finding from an outside review of the prompts and evidence handling: local validation was much weaker than the evidence policy in the prompts. The validator mostly confirmed that a quotation existed in retrieved text, not that it supported the fields attached to it. The reviewer's offline probes kept a "verified" status for three unsupported claims:

- an NFPA 13 adoption whose only evidence was "NFPA 13, 2019 edition, is available from our catalog", with an invented adoption instrument;
- a contact with an invented phone number;
- a general code row whose edition the quotation did not state.

The prompts already prohibit all three. The checks below make local validation enforce part of that policy instead of relying on the model.

## Adoption-chain quotations need adopting or in-force wording

**Before.** A screened standard row (NFPA for fire protection, referenced standards for other disciplines) passed its adoption check when any supported quotation came from the row's `adoptionSourceId`. A catalog page quoted for its edition also counted as the adoption chain when both IDs named it.

**Now.** At least one supported quotation from the adoption source must contain adopting or in-force wording (`ADOPTION_WORDING` in `lib/screening.mjs`):

- adopt, incorporated by reference (or herein, or the French incorporé par renvoi), enact, promulgate, hereby, enforce/enforced/enforces;
- in force, into force, en vigueur, takes effect, becomes or became effective;
- effective on, as of, from or for, or effective followed by a date.

A bare "effective date" does not count, because a published standard's front matter states its own ("issued with an effective date of August 21, 2018"). Nor do a bare "incorporates" or "amendment", because a publisher says an edition "incorporates Tentative Interim Amendments", or mandatory code language such as "shall be installed in accordance with": a model code says that whether or not a jurisdiction adopted it.

A row that fails stays unverified, and its note says "the adoption-chain quotation does not say the standard or its parent code is adopted or in force". The confirm question is added as for any other unverified row. A referenced adoption still passes when the row also quotes the parent code's adoption (for example a state adopting the IBC), with the edition from the reference table. The table row alone no longer verifies the adoption.

The review prompt for both NFPA and discipline rows now says the adoption-chain quotation must itself carry this wording and that a catalog listing or a standard's own effective date does not.

**Limits.** This is a vocabulary check, not a legal reading. "NFPA 13 has been adopted by many jurisdictions" on a publisher's page would pass. The adoption instrument the row names is still not matched against the source; instruments are usually paraphrased, and an exact match would demote correct rows.

## Code rows need their edition year in a supported quotation

**Before.** An ordinary code row (in `codes`, not a screened standard) was demoted only when its edition was blank or said unknown. Any supported quotation verified it, whatever edition the row claimed.

**Now.** A verified code row needs a supported quotation containing the edition's year. A yearless edition such as "Eighth Edition" must appear as written. A year elsewhere in the cited source does not count. A row that fails becomes unverified with the note "Edition check: no supported quotation contains the edition year", and the existing "Confirm … and its applicable edition" question is added.

**Limits.** The year is not tied to the code's name the way screened standard rows tie a designation to its edition, so a quotation naming 2021 for a different code would pass. Adoption and edition source IDs for ordinary code rows, which would allow that binding, are a report schema change and are deferred.

## Phone numbers are checked like emails

**Before.** A listed email had to appear in a cited source's text, or it was cleared and the row demoted. Phone numbers were not checked.

**Now.** Each phone number in an authority's or contact's `phone` field must appear in a cited source. Numbers are compared by their digits, so "(703) 555-1234", "703.555.1234" and "+1 703-555-1234" match one another, and an extension is ignored. A number with fewer than seven digits, such as 311, or with letters must appear as written. A number that fails is cleared and the row demoted, as for an email. An area code the source does not show counts as unsupported.

**Limits.** Contact names, titles and office details are still not matched against sources. A person's or office's name is often reworded from the source, and matching it exactly would demote correct contacts.

## Existing reports

Validation runs when the final report is generated. Saved reports keep their statuses until a new report replaces them. To see which saved findings the new rules would change, run `node tests/replay-saved-run.mjs <project-id>` against the project database. It reports code and standard rows whose status would change. It does not report contact phone changes, and it sends no requests.

## Validation

All three new tests fail on the previous code and pass with this change.

- **`tests/fire-protection.test.mjs`.** The reviewer's catalog probe demotes the row with the new note and adds the confirm question. Seven adopting or in-force clauses, in English and French, verify the row. A standard's own effective date, a descriptive sentence and an edition that "incorporates Tentative Interim Amendments" do not. Adoption wording quoted from a different source than the adoption source does not count.
- **`tests/discipline-screening.test.mjs`.** A bookstore listing for ASHRAE 90.1-2019 no longer verifies the mechanical row.
- **`tests/core.test.mjs`.** Two cases demote a code row and add its edition question: a 2024 edition the quotation does not state, and a quotation without the year. A yearless edition quoted as written verifies. An invented contact phone and an invented authority phone are cleared and their rows demoted. The same numbers written with different punctuation, a leading 1 or an extension are kept.

The table-cell test in `tests/fire-protection.test.mjs` now quotes the adoption separately from the referenced-documents row. Before, the table row alone verified the standard. These are deterministic tests; no paid requests are made.
