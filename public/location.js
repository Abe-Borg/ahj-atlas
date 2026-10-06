// AHJ Atlas researches projects in the United States and Canada. The project form and
// the server read an address with this module, so both reach the same country.
export const COUNTRIES=['United States','Canada'];
// Letters only, so "U.S.", "U.S.A." and "United-States" compare like "US", "USA" and "United States".
export function isUnitedStates(country){
  const name=String(country||'').toLowerCase().replace(/[^a-z]/g,'');
  return name.includes('unitedstates')||/^(?:the)?(?:us|usa|america)$/.test(name);
}
// The supported country a saved or entered value names, or '' for any other value.
// In a country field "CA" is Canada's ISO code; in an address it can mean California.
export function countryName(value){
  if(isUnitedStates(value))return 'United States';
  return /^(?:canada|ca)$/.test(String(value||'').toLowerCase().replace(/[^a-z]/g,''))?'Canada':'';
}
export const STATES={AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',PR:'Puerto Rico',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
export const PROVINCES={AB:'Alberta',BC:'British Columbia',MB:'Manitoba',NB:'New Brunswick',NL:'Newfoundland and Labrador',NS:'Nova Scotia',NT:'Northwest Territories',NU:'Nunavut',ON:'Ontario',PE:'Prince Edward Island',QC:'Quebec',SK:'Saskatchewan',YT:'Yukon'};
// Canada Post never uses D, F, I, O, Q or U, nor W or Z as the first letter.
const POSTAL_CODE=/(?<![\p{L}\d])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d(?![\p{L}\d])/iu;
const ZIP=/^\d{5}(?:-\d{4})?$/,ENDS_WITH_ZIP=/(?:^|\s)\d{5}(?:-\d{4})?$/;
// Accents are compared without their marks, so "Québec" matches Quebec.
const fold=text=>text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
// The state or province ending one comma-separated part of an address, by two-letter code
// or full name, after any ZIP or postal code; "Montréal (Québec)" reads as Quebec. rest is
// the text before it.
export function regionIn(segment,regions=STATES){
  const text=String(segment).normalize('NFC').replace(/\b\d{5}(?:-\d{4})?\b/,'').replace(POSTAL_CODE,'').replace(/[()]/g,' ').replace(/\s+/g,' ').replace(/[\s,]+$/,'').trim();
  const code=text.match(/(?:^|\s)([A-Za-z]{2})$/)?.[1]?.toUpperCase();
  if(code&&regions[code])return {region:regions[code],rest:text.slice(0,-2).trim()};
  const folded=fold(text),name=Object.values(regions).find(n=>folded===n.toLowerCase()||folded.endsWith(' '+n.toLowerCase()));
  if(!name)return null;
  // Folding keeps a precomposed accented letter one character long, so the lengths agree.
  const rest=(folded.length===text.length?text:folded).slice(0,text.length-name.length).trim();
  return {region:name,rest};
}
// The country an address names, or null. A postal code, a state followed by its ZIP code,
// or a trailing country name is definite; a state or province alone ending the address is
// only likely. A bare trailing "CA" could be Canada or California, so it decides nothing.
export function addressCountry(address){
  const text=String(address||'').normalize('NFC');
  if(POSTAL_CODE.test(text))return {country:'Canada',definite:true};
  const parts=text.split(',').map(s=>s.trim()).filter(Boolean),last=parts.at(-1)||'';
  // Only a part without digits can be a country name: "CA 91761" is a state and ZIP code.
  if(/^[\p{L} .'-]+$/u.test(last)){
    if(last.toLowerCase().replace(/[^a-z]/g,'')==='ca')return null;
    const named=countryName(last);if(named)return {country:named,definite:true};
  }
  let zip=false;
  for(let i=parts.length-1;i>=0;i--){
    if(ZIP.test(parts[i])){zip=true;continue;}
    if(regionIn(parts[i],PROVINCES))return {country:'Canada',definite:false};
    if(regionIn(parts[i],STATES))return {country:'United States',definite:zip||ENDS_WITH_ZIP.test(parts[i])};
    return null;
  }
  return null;
}
