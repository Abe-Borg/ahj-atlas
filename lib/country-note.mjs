import { countryName } from '../public/location.js';
import { isFireProtection } from './fire-protection.mjs';

// Research, the final review and chat were written around US code adoption. A Canadian
// project adds this note; every other project gets '' and keeps byte-identical prompts.
// It names what to check, not answers: editions and authorities still come from sources.
const LEADS={
  research:field=>`Canadian project (${field}.country is Canada). Research these Canadian frameworks instead of assuming US ones such as the IBC, IFC, NEC or state and county adoption:`,
  review:field=>`Canadian project (${field}.country is Canada). Report findings within these Canadian frameworks, and treat a finding that rests on a US model code or US-style adoption without Canadian evidence as unsupported:`,
  chat:()=>'This project is in Canada. When you research, use these Canadian frameworks instead of assuming US ones such as the IBC, IFC, NEC or state and county adoption:',
};
const CHECKS=[
  'Codes are adopted by the province or territory. Identify the building, fire, plumbing and energy codes in force for the site: a National Code of Canada (published by the National Research Council) adopted directly, or a provincial code based on it (Ontario, British Columbia, Quebec and Alberta publish their own), with its edition, effective date, amendments and any transition period. Municipalities usually administer and enforce these codes rather than amend them; check for a municipal building by-law where one exists (for example Vancouver\'s) and for fire, zoning and development by-laws.',
  'Identify the municipality and any upper-tier or regional government (regional municipality, county, regional district, municipal district, rural municipality) or unorganized area for the site. First Nations reserve land and federal land or federally regulated facilities can fall outside provincial and municipal authority.',
  'Fire authority: the municipal fire department or fire prevention office, and the provincial or territorial Fire Marshal or Fire Commissioner.',
  'Electrical, boiler and pressure vessel, elevating device and fuel gas approvals are often provincial or delegated to a safety authority (for example Ontario\'s Electrical Safety Authority and TSSA, Technical Safety BC, or ABSA in Alberta) rather than municipal. Electrical work follows the Canadian Electrical Code, Part I (CSA C22.1), as the province adopts it.',
  'Referenced standards include CSA and ULC (CAN/ULC) standards as well as NFPA and others. Trace each through the governing code\'s referenced-documents table (Division B, Table 1.3.1.2 in the national codes and in codes based on them) and any provincial amendment.',
  'In Quebec most official sources are in French: search for and read French-language sources (for example the Régie du bâtiment du Québec and municipal règlements) and quote them in French. Federal and New Brunswick sources are bilingual.',
];
const FIRE_CHECK='Fire protection: where the governing code references them, screen CAN/ULC-S524 (fire alarm installation), CAN/ULC-S536 and S537 (fire alarm inspection and verification), CAN/ULC-S1001 (integrated systems testing) and CSA C282 (emergency power). NFPA 72, NFPA 70, NFPA 110, NFPA 1 and NFPA 101 are usually not the governing documents in Canada; record what the adoption evidence shows for each rather than assuming either way.';
export function countryNote(input={},{use='research',field='projectInputs'}={}){
  if(countryName(input.country)!=='Canada')return '';
  return '\n'+[LEADS[use](field),...CHECKS,...(isFireProtection(input)?[FIRE_CHECK]:[])].join('\n- ');
}
