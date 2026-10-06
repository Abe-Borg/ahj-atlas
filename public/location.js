// AHJ Atlas researches projects in the United States and Canada. The project form and
// the server read an address with this module, so both reach the same country.
export const COUNTRIES=['United States','Canada'];
// Letters only, so "U.S.", "U.S.A." and "United-States" compare like "US", "USA" and "United States".
export function isUnitedStates(country){
  const name=String(country||'').toLowerCase().replace(/[^a-z]/g,'');
  return name.includes('unitedstates')||/^(?:the)?(?:us|usa|america)$/.test(name);
}
// The supported country a value names as a whole, or '' for any other value, so "not
// United States" is refused. In a country field "CA" is Canada's ISO code; in an address it
// can mean California.
export function countryName(value){
  const name=String(value||'').toLowerCase().replace(/[^a-z]/g,'');
  if(/^(?:the)?(?:unitedstates(?:ofamerica)?|us|usa|america)$/.test(name))return 'United States';
  return /^(?:canada|ca)$/.test(name)?'Canada':'';
}
// A country named at the end of an address without a comma before it, as in
// "Toronto Ontario Canada" or "Springfield IL 62701 United States". A bare "us" is a
// word, so only the capitals "US" count.
const COUNTRY_SUFFIX=/(?:^|[\s,])(united\s+states(?:\s+of\s+america)?|u\.?\s?s\.?\s?a\.?|u\.\s?s\.|canada)\s*$/i,US_SUFFIX=/(?:^|[\s,])(US)\s*$/;
export function countrySuffix(part){
  const match=String(part).match(COUNTRY_SUFFIX)||String(part).match(US_SUFFIX);
  return match?{country:countryName(match[1]),rest:String(part).slice(0,match.index).trim()}:null;
}
export const STATES={AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',PR:'Puerto Rico',GU:'Guam',VI:'Virgin Islands',AS:'American Samoa',MP:'Northern Mariana Islands',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
export const PROVINCES={AB:'Alberta',BC:'British Columbia',MB:'Manitoba',NB:'New Brunswick',NL:'Newfoundland and Labrador',NS:'Nova Scotia',NT:'Northwest Territories',NU:'Nunavut',ON:'Ontario',PE:'Prince Edward Island',QC:'Quebec',SK:'Saskatchewan',YT:'Yukon'};
// Canada Post never uses D, F, I, O, Q or U, nor W or Z as the first letter.
const POSTAL_CODE=/(?<![\p{L}\d])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d(?![\p{L}\d])/iu;
const ZIP=/^\d{5}(?:-\d{4})?$/,ENDS_WITH_ZIP=/(?:^|\s)\d{5}(?:-\d{4})?$/;
// Accents are compared without their marks, so "Québec" matches Quebec.
const fold=text=>text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
// The state or province ending one comma-separated part of an address, by two-letter code
// (dotted codes such as "D.C." included) or full name, after any ZIP or postal code;
// "Montréal (Québec)" reads as Quebec. rest is the text before it.
export function regionIn(segment,regions=STATES){
  // The ZIP code is the one ending the part, never a five-digit street number before it.
  const text=String(segment).normalize('NFC').trim().replace(/\b\d{5}(?:-\d{4})?$/,'').replace(POSTAL_CODE,'').replace(/[()]/g,' ').replace(/\s+/g,' ').replace(/[\s,]+$/,'').trim();
  const code=text.match(/(?:^|\s)(?:([A-Za-z]{2})|([A-Za-z])\.\s?([A-Za-z])\.?)$/),key=code&&(code[1]||code[2]+code[3]).toUpperCase();
  if(key&&regions[key])return {region:regions[key],rest:text.slice(0,code.index).trim()};
  // Longest names first, so "West Virginia" is not read as Virginia.
  const folded=fold(text),name=Object.values(regions).sort((a,b)=>b.length-a.length).find(n=>folded===n.toLowerCase()||folded.endsWith(' '+n.toLowerCase()));
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
  const suffix=countrySuffix(last);
  if(suffix)return {country:suffix.country,definite:true};
  let zip=false;
  for(let i=parts.length-1;i>=0;i--){
    if(ZIP.test(parts[i])){zip=true;continue;}
    if(regionIn(parts[i],PROVINCES))return {country:'Canada',definite:false};
    if(regionIn(parts[i],STATES))return {country:'United States',definite:zip||ENDS_WITH_ZIP.test(parts[i])};
    return null;
  }
  return null;
}
