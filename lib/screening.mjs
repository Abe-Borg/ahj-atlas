// Discipline screening: a checklist of referenced standards that code research and the
// evidence check must answer one row at a time, a completion gate that needs every row,
// and a report section whose adopted editions need quoted adoption and edition evidence.
// Fire protection keeps its NFPA profile and wording (fire-protection.mjs); the other
// disciplines use the profiles below. Targets are research leads, not an adoption list:
// no edition appears here, and every edition must come from project evidence.
import { APPLICABILITY, normalizeEnum, normalizeCompletion } from './model-values.mjs';
import { isResolvedStatus, resolvedCovers, resolvedQuestionText } from './questions.mjs';
import { countryName } from '../public/location.js';
import { FIRE_PROFILE_VERSION, isFireProtection, fireProfile, fireInstructions, nfpaIds, individualStandard, checklistStandard, nfpaEdition, PUBLISHER, ANOTHER } from './fire-protection.mjs';

export const SCREENING_PROFILE_VERSION=1;
const DATA_CENTER=/data[\s-]*cent(?:er|re)|hyperscale|server|\bIT equipment\b/i,HEALTH_CARE=/hospital|health[\s-]*care|medical|clinic|surgical|nursing/i,EXISTING=/renovation|alteration|addition|tenant improvement|change of occupancy|existing building|retrofit/i;
// Each profile lists US and Canadian baseline targets, then [pattern, US targets, Canadian
// targets] groups that project context (scope, building use, notes and answers) adds.
const PROFILES=[
  {id:'architecture',label:'Architecture',match:/architect|interior design|accessib|envelope|fa[cç]ade|life[\s-]*safety|code consult/i,
    offices:'the planning/zoning office, the Fire Marshal/fire prevention office and any separate accessibility review',
    us:{core:[['ICC A117.1','Accessible and usable buildings and facilities'],['NFPA 80','Fire doors and other opening protectives'],['NFPA 101','Life safety framework (where adopted or required by a funding or licensing agency)'],['NFPA 285','Exterior wall assemblies with combustible components'],['ASTM E84','Surface burning characteristics of interior finishes'],['ASTM E119','Fire-resistance tests of building construction'],['ASTM E814','Fire tests of penetration firestop systems'],['ASHRAE 90.1','Energy standard (envelope compliance path)']],
      examples:'ICC A117.1 or ASTM E119',grouped:'ASTM E84 and E119',hint:'IBC Chapter 35',models:'the IBC, IEBC and IECC, or state codes based on them',
      screen:'Also screen construction type, fire-resistance ratings, exterior wall assemblies, interior finishes, the energy-code envelope compliance path and owner/insurer criteria; ask about missing occupancy, height and area facts. Federal accessibility law (the 2010 ADA Standards for Accessible Design) applies independently of local code adoption; record it separately from the adopted accessibility standard.'},
    ca:{core:[['CSA B651','Accessible design for the built environment'],['CAN/ULC-S101','Fire endurance tests of building construction'],['CAN/ULC-S102','Surface burning characteristics'],['CAN/ULC-S115','Fire tests of firestop systems'],['CAN/ULC-S134','Fire test of exterior wall assemblies'],['NFPA 80','Fire doors and other opening protectives'],['ASHRAE 90.1','Energy standard (where permitted as an alternative to the NECB)']],
      examples:'CSA B651 or CAN/ULC-S101',grouped:'CAN/ULC-S101 and S102',hint:'Division B, Table 1.3.1.2 of the national or provincial building code',models:'the national or provincial building and energy codes',
      screen:'Also screen construction type, fire-resistance ratings, exterior wall assemblies, interior finishes, the energy-code envelope compliance path and owner/insurer criteria; ask about missing occupancy, height and area facts.'},
    groups:[[DATA_CENTER,[['NFPA 75','IT equipment rooms: construction and separation']],[['NFPA 75','IT equipment rooms: construction and separation']]],
      [HEALTH_CARE,[['NFPA 99','Health care facilities']],[['CSA Z8000','Health care facilities planning and design']]],
      [/smoke control|atrium|high[\s-]*rise/i,[['NFPA 92','Smoke control'],['NFPA 105','Smoke doors and opening protectives']],[]],
      [/school|education|\bK-12\b|\b911\b|emergency operations|storm shelter|tornado/i,[['ICC 500','Storm shelters']],[]]]},
  {id:'structural',label:'Structural',match:/structur|seismic/i,
    offices:'structural plan review and the special inspection program',
    us:{core:[['ASCE 7','Minimum design loads (wind, seismic, snow, rain and flood)'],['ACI 318','Structural concrete'],['AISC 360','Structural steel buildings'],['AISC 341','Seismic provisions for structural steel'],['AISI S100','Cold-formed steel design'],['AWS D1.1','Structural welding of steel'],['TMS 402','Masonry structures']],
      examples:'ASCE 7 or ACI 318',grouped:'ACI 318, AISC 360 and TMS 402',hint:'IBC Chapter 35 and the structural design provisions of IBC Chapter 16',models:'the IBC and IEBC, or state codes based on them',
      screen:'Also screen risk category, seismic design category, wind, snow and flood criteria, special inspection and structural observation requirements, existing-building provisions and owner criteria; ask about missing structural system details.'},
    ca:{core:[['CSA A23.3','Design of concrete structures'],['CSA A23.1','Concrete materials and methods of construction'],['CSA S16','Design of steel structures'],['CSA W59','Welded steel construction'],['CSA S136','Cold-formed steel structural members'],['CSA O86','Engineering design in wood'],['CSA S304','Design of masonry structures']],
      examples:'CSA A23.3 or CSA S16',grouped:'CSA A23.3, S16 and O86',hint:'Division B, Table 1.3.1.2 of the national or provincial building code (Part 4 structural design)',models:'the national or provincial building code',
      screen:'Also screen importance category, seismic category, climatic design data, field review requirements, existing-building provisions and owner criteria; ask about missing structural system details.'},
    groups:[[EXISTING,[['ASCE 41','Seismic evaluation and retrofit of existing buildings']],[]],
      [/flood/i,[['ASCE 24','Flood resistant design and construction']],[]]]},
  {id:'mechanical',label:'Mechanical',match:/mechanical|\bHVAC\b|\bMEP\b|refrigerat|ventilat|\bheating\b|\bcooling\b/i,
    offices:'the Fire Marshal/fire prevention office (smoke control, fire dampers and fuel storage) and any air quality agency that permits generators or boilers',
    us:{core:[['ASHRAE 15','Refrigeration system safety'],['ASHRAE 34','Refrigerant designation and safety classification'],['ASHRAE 62.1','Ventilation and acceptable indoor air quality'],['ASHRAE 90.1','Energy standard (HVAC efficiency and controls)'],['NFPA 90A','Air-conditioning and ventilating systems'],['NFPA 91','Exhaust systems for air conveying of vapors, gases, mists and particulate solids'],['NFPA 54','National Fuel Gas Code (fuel gas piping and appliances)']],
      examples:'ASHRAE 62.1 or NFPA 90A',grouped:'ASHRAE 15, 62.1 and 90.1',hint:'the referenced-standards chapters of the IMC or UMC and of the IECC',models:'the IMC or UMC, the IFGC and the IECC, or state codes based on them',
      screen:'Also screen refrigerant type and charge, the energy-code compliance path, the ventilation design procedure, smoke control, fuel storage and owner/insurer criteria; ask about missing system details.'},
    ca:{core:[['CSA B52','Mechanical refrigeration code'],['CSA B149.1','Natural gas and propane installation code'],['ASHRAE 62.1','Ventilation and acceptable indoor air quality'],['ASHRAE 90.1','Energy standard (where permitted as an alternative to the NECB)']],
      examples:'ASHRAE 62.1 or CSA B52',grouped:'CSA B52 and B149.1',hint:'Division B, Table 1.3.1.2 of the national or provincial building and energy codes',models:'the national or provincial building and energy codes',
      screen:'Also screen refrigerant type and charge, the energy-code compliance path, the ventilation design procedure, smoke control, fuel storage and owner/insurer criteria; ask about missing system details.'},
    groups:[[DATA_CENTER,[['ASHRAE 90.4','Energy standard for data centers'],['NFPA 75','IT equipment rooms: HVAC and shutdown'],['NFPA 37','Stationary engines: combustion air and exhaust'],['NFPA 30','Fuel storage and piping']],[['ASHRAE 90.4','Energy standard for data centers'],['NFPA 75','IT equipment rooms: HVAC and shutdown']]],
      [/generator|diesel|fuel oil|standby power/i,[['NFPA 37','Stationary engines: combustion air and exhaust'],['NFPA 30','Fuel storage and piping']],[]],
      [/\bA2L\b|flammable refrigerant/i,[['UL 60335-2-40','Heat pumps and air conditioners with flammable refrigerants']],[]],
      [HEALTH_CARE,[['ASHRAE 170','Ventilation of health care facilities'],['NFPA 99','Health care facilities']],[['CSA Z317.2','HVAC systems in health care facilities']]],
      [/laborator/i,[['NFPA 45','Laboratories using chemicals']],[['NFPA 45','Laboratories using chemicals']]],
      [/kitchen|restaurant|cooking|food service/i,[['NFPA 96','Commercial cooking ventilation']],[['NFPA 96','Commercial cooking ventilation']]],
      [/smoke control|atrium|high[\s-]*rise/i,[['NFPA 92','Smoke control systems']],[]],
      [/boiler|steam/i,[['ASME CSD-1','Controls and safety devices for automatically fired boilers']],[['CSA B51','Boiler, pressure vessel and pressure piping code']]],
      [/ammonia/i,[['IIAR 2','Ammonia refrigeration systems']],[]]]},
  {id:'electrical',label:'Electrical',match:/electric|\bMEP\b|\bpower\b|lighting|telecom|low[\s-]*voltage/i,
    offices:'the electrical inspection authority (a provincial safety authority in much of Canada), the Fire Marshal/fire prevention office (fire alarm and energy storage) and the electric utility (service and interconnection)',
    us:{core:[['NFPA 70','National Electrical Code'],['NFPA 72','Fire alarm and signaling'],['NFPA 110','Emergency and standby power systems'],['NFPA 101','Life safety framework (emergency and egress lighting)'],['ASHRAE 90.1','Energy standard (lighting and power)']],
      examples:'NFPA 70 or NFPA 110',grouped:'NFPA 70, 72 and 110',hint:'the state or local adoption of the NEC (NFPA 70) with its amendments, and the referenced-standards chapters of the IBC and IECC',models:'the building, fire and energy codes',
      screen:'Also screen emergency, legally required standby and optional standby power classification, fire alarm scope, energy storage, utility service and interconnection requirements, the energy-code lighting and power compliance path, and owner/insurer criteria; ask about missing system details.'},
    ca:{core:[['CSA C22.1','Canadian Electrical Code, Part I'],['CSA C282','Emergency electrical power supply for buildings'],['CAN/ULC-S524','Installation of fire alarm systems'],['ASHRAE 90.1','Energy standard (where permitted as an alternative to the NECB)']],
      examples:'CSA C22.1 or CSA C282',grouped:'CSA C22.1 and C282',hint:'the provincial or territorial adoption of the Canadian Electrical Code, Part I, with its amendments, and Division B, Table 1.3.1.2 of the national or provincial building code',models:'the national or provincial building, fire and energy codes',
      screen:'Also screen emergency power classification, fire alarm scope, energy storage, utility service and interconnection requirements, the energy-code lighting and power compliance path, and owner/insurer criteria; ask about missing system details.'},
    groups:[[DATA_CENTER,[['NFPA 75','IT equipment protection'],['NFPA 111','Stored electrical energy emergency and standby power'],['NFPA 780','Lightning protection'],['NFPA 70E','Workplace electrical safety (owner and OSHA criteria, not a building code)']],[['NFPA 75','IT equipment protection'],['CSA Z462','Workplace electrical safety (owner and occupational criteria, not a building code)']]],
      [/\bESS\b|\bUPS\b|batter|energy storage/i,[['NFPA 855','Stationary energy storage systems'],['UL 9540','Energy storage systems and equipment']],[['NFPA 855','Stationary energy storage systems'],['UL 9540','Energy storage systems and equipment']]],
      [/substation|medium[\s-]*voltage|high[\s-]*voltage|switchyard|utility interconnect/i,[['IEEE C2','National Electrical Safety Code (utility-side installations)']],[]],
      [HEALTH_CARE,[['NFPA 99','Health care facilities (essential electrical systems)']],[['CSA Z32','Electrical safety and essential electrical systems in health care facilities']]],
      [/telecom/i,[['NFPA 76','Telecommunications facilities']],[]]]},
  {id:'plumbing',label:'Plumbing',match:/plumb|\bMEP\b|fuel[\s-]*gas|medical[\s-]*gas/i,
    offices:'the water purveyor\'s cross-connection control program, the health department where food service or pools apply, and the fuel gas authority where it differs',
    us:{core:[['ASSE 1013','Reduced pressure principle backflow preventers'],['ASSE 1070','Water temperature limiting devices'],['NSF 61','Drinking water system components (health effects)'],['ICC A117.1','Accessible plumbing fixtures and clearances'],['ASHRAE 188','Legionellosis risk management for building water systems'],['ASHRAE 90.1','Energy standard (service water heating)'],['NFPA 54','National Fuel Gas Code (fuel gas piping and appliances)']],
      examples:'ASSE 1013 or NSF 61',grouped:'ASSE 1013 and 1070',hint:'the referenced-standards chapter of the IPC or UPC',models:'the IPC or UPC and the IFGC, or state codes based on them',
      screen:'Also screen the water purveyor\'s cross-connection control requirements, fuel gas, medical gas, grease interception, water heating and temperature limits, Legionella water management, and owner criteria; ask about missing fixture and system details.'},
    ca:{core:[['CSA B64.10','Selection and installation of backflow preventers'],['CSA B149.1','Natural gas and propane installation code'],['CSA B651','Accessible plumbing fixtures and clearances']],
      examples:'CSA B64.10 or CSA B149.1',grouped:'CSA B64.10 and B149.1',hint:'Division B, Table 1.3.1.2 of the national or provincial plumbing code',models:'the national or provincial plumbing and building codes',
      screen:'Also screen the water purveyor\'s cross-connection control requirements, fuel gas, medical gas, grease interception, water heating and temperature limits, and owner criteria; ask about missing fixture and system details.'},
    groups:[[HEALTH_CARE,[['NFPA 99','Medical gas and vacuum systems']],[['CSA Z7396.1','Medical gas pipeline systems'],['CSA Z317.1','Plumbing in health care facilities']]],
      [/laborator|chemical|batter|corrosive|eyewash/i,[['ISEA Z358.1','Emergency eyewash and shower equipment'],['ASSE 1071','Temperature actuated mixing valves for emergency fixtures']],[['ISEA Z358.1','Emergency eyewash and shower equipment']]],
      [/kitchen|restaurant|food service|grease/i,[['ASME A112.14.3','Hydromechanical grease interceptors']],[]],
      [/propane|\bLPG\b|\bLP-gas\b/i,[['NFPA 58','Liquefied petroleum gas']],[['CSA B149.2','Propane storage and handling']]],
      [/rainwater|gr[ae]ywater|reclaimed|non-potable|water reuse/i,[],[['CSA B128.1','Non-potable water systems']]]]},
  {id:'civil',label:'Civil',match:/civil|\bsite\b|stormwater|grading|land[\s-]*development/i,
    offices:'public works or the city engineer, the water, sewer and stormwater utilities, the Fire Marshal/fire prevention office (fire apparatus access and hydrants) and any environmental permitting agency',
    us:{core:[['NFPA 24','Private fire service mains'],['AWWA C600','Installation of ductile-iron water mains'],['AWWA C651','Disinfecting water mains'],['AWWA C900','PVC pressure pipe (where specified)'],['ICC A117.1','Accessible site routes, parking and entrances']],
      examples:'AWWA C651 or NFPA 24',grouped:'AWWA C600 and C651',hint:'the jurisdiction\'s engineering design standards and the fire code provisions and appendices on fire service features, fire flow and hydrants as adopted',models:'the IBC and IFC (with any adopted appendices) and local engineering standards',
      screen:'Also research the jurisdiction\'s engineering design standards and specifications, stormwater management and erosion control rules (including any construction stormwater permit), fire apparatus access and fire flow provisions in the adopted fire code and its appendices, and utility service requirements; these govern site work even where they carry no standards designation. Ask about missing site facts.'},
    ca:{core:[['NFPA 24','Private fire service mains'],['AWWA C600','Installation of ductile-iron water mains'],['AWWA C651','Disinfecting water mains'],['CSA B651','Accessible exterior routes, parking and entrances']],
      examples:'AWWA C651 or CSA B651',grouped:'AWWA C600 and C651',hint:'the municipality\'s engineering design standards and the referenced documents of the national or provincial building and fire codes',models:'the national or provincial building and fire codes and municipal engineering standards',
      screen:'Also research the municipality\'s engineering design standards and specifications, stormwater management and erosion and sediment control rules, fire department access and fire flow requirements, and utility service requirements; these govern site work even where they carry no standards designation. Ask about missing site facts.'},
    groups:[[/flood/i,[['ASCE 24','Flood resistant design and construction']],[]]]},
];
export const DISCIPLINE_PROFILES=PROFILES.map(p=>p.id);

// Designations: a known publisher, optional co-publishers ("ANSI/ASHRAE/IES", "ASCE/SEI")
// and a document number. An edition suffix ("-19", "-2019") is not part of the number;
// a multi-part number ("60335-2-40") is. CAN/ULC keeps its prefix in the canonical form.
const PUBS='NFPA|ASHRAE|ASCE|ACI|AISC|AISI|ASME|ASTM|AWWA|AWS|ASSE|ASSP|CSA|ULC|UL|ICC|IAPMO|IEEE|IEC|ISO|ISEA|NSF|TIA|TMS|PDI|IIAR|NEMA|ANSI';
const NUMBER='(?:[A-Z]{1,4}-?)?\\d+[A-Z]?(?:\\.\\d+[A-Z]?)*';
const DESIGNATION=new RegExp(`(?<![\\w/])(?:(?:ANSI|CAN)\\/)*(${PUBS})(?:\\/[A-Z]{2,6})*(?:\\s+(?:Standard|Std\\.?))?\\s*(?:[-–]|\\|)?\\s*(${NUMBER}(?:(?:-\\d{1,3}){2,}(?!\\d))?)(?![\\w]|\\.\\d)`,'gi');
// A document cited under ANSI alone is the same document as its developer's designation.
const ALIASES={'ANSI A117.1':'ICC A117.1','ANSI Z358.1':'ISEA Z358.1','ANSI C2':'IEEE C2'};
// Codes cited by name rather than number.
const NAMES=[[/\bNational Electrical Code\b|\bNEC\b/g,'NFPA 70'],[/\bNational Electrical Safety Code\b|\bNESC\b/g,'IEEE C2'],[/\bCanadian Electrical Code\b/g,'CSA C22.1'],[/\bNational Fuel Gas Code\b/g,'NFPA 54']];
const canonical=(pub,num)=>{pub=pub.toUpperCase();num=num.toUpperCase();const id=pub==='ULC'?'CAN/ULC-'+num:pub+' '+num;return ALIASES[id]||id;};
export function standardIds(value){
  const text=String(value||''),found=[...text.matchAll(DESIGNATION)].map(m=>[m.index,canonical(m[1],m[2])]);
  for(const [pattern,id] of NAMES)for(const m of text.matchAll(pattern))found.push([m.index,id]);
  return [...new Set(found.sort((a,b)=>a[0]-b[0]).map(([,id])=>id))];
}
// "AWS D1.1/D1.1M" is one document in customary and metric units, not two designations.
const metricTwin=text=>text.replace(/(\b[A-Z]{0,4}\d+(?:\.\d+)*)\/\1M\b/gi,'$1');
function singleStandard(value){
  const text=metricTwin(String(value||'').trim());
  return standardIds(text).length===1&&!ANOTHER.test(text.slice(text.match(PUBLISHER)?.[0].length||0));
}
// A checklist row names one standard. A labelled row ("ASHRAE 62.1 – Ventilation") counts
// as its designation; a designation from another publisher stays as written.
function checklistRow(value,examples){
  const text=String(value??'').trim(),ids=standardIds(text),rest=metricTwin(text).slice(text.match(PUBLISHER)?.[0].length||0),grouped=ANOTHER.test(rest);
  if(ids.length===1&&!grouped)return {standard:ids[0],label:text===ids[0]?'':text};
  if(ids.length>1||grouped)return {error:'one designation per row'};
  if(text.length>160||!PUBLISHER.test(text)||!/^[^|\n]{0,40}?\d/.test(rest))return {error:'a designation such as '+examples};
  return {standard:text,label:''};
}

// Parent codes whose year must not be read as a standard's edition.
const PARENTS='IBC|IFC|IMC|IPC|IECC|IFGC|IEBC|IRC|IgCC|UMC|UPC|CBC|CFC|CMC|CPC|CEBC|CEC|VCC|USBC|SFPC|NBC|NFC|NPC|NECB|OBC|OFC|BCBC|BCFC|CNB|CNPI|NEC|NESC|Title 24|International (?:Building|Fire|Mechanical|Plumbing|Energy Conservation|Fuel Gas|Existing Building|Residential|Green Construction) Code|Uniform (?:Mechanical|Plumbing) Code|National (?:Building|Fire|Plumbing|Electrical|Electrical Safety|Energy|Fuel Gas) Code(?: of Canada(?: for Buildings)?)?|Canadian Electrical Code|(?:California|Ontario|British Columbia|Alberta|Florida|New York(?: State)?) (?:Building|Fire|Mechanical|Plumbing|Electrical|Energy|Existing Building) Code|Code (?:national|de construction|de s[ée]curit)';
const STOP=new RegExp(`(?:(?:19|20)\\d{2}\\s*)?\\b(?:${PARENTS})\\b|(?:(?:ANSI|CAN)\\/)*\\b(?:${PUBS})(?:\\/[A-Z]{2,6})*(?:\\s+(?:Standard|Std\\.?))?\\s*(?:[-–]|\\|)?\\s*(?:[A-Z]{1,4}-?)?\\d`,'gi');
const escape=text=>text.replace(/[.*+?^${}()|[\]\\\/-]/g,'\\$&');
const parts=id=>{const m=/^(?:CAN\/)?([A-Z]+)[-\s](.+)$/.exec(id);return {pub:m[1],num:m[2]};};
const nameSources=id=>NAMES.filter(([,to])=>to===id).map(([pattern])=>pattern.source);
function designationPattern(id){
  const alternatives=[id,...Object.keys(ALIASES).filter(from=>ALIASES[from]===id)].map(d=>{const {pub,num}=parts(d);return `(?<![\\w/])(?:(?:ANSI|CAN)\\/)*${pub}(?:\\/[A-Z]{2,6})*(?:\\s+(?:Standard|Std\\.?))?\\s*(?:[-–]|\\|)?\\s*${escape(num)}(?![\\w]|\\.\\d)`;});
  return new RegExp([...alternatives,...nameSources(id)].join('|'),'i');
}
// Cut the text after a designation at the next standard or parent code, so its year is
// not taken for this edition. The standard's own names ("National Electrical Code" for
// NFPA 70) do not cut it.
function beforeNextReference(tail,id){
  const own=nameSources(id).length?new RegExp('^(?:'+nameSources(id).join('|')+')$','i'):null;
  for(const m of tail.matchAll(STOP))if(!own||!own.test(m[0].replace(/^(?:19|20)\d{2}\s*/,'')))return tail.slice(0,m.index);
  return tail;
}
// The NFPA check in fire-protection.mjs, for any designation. A year is accepted after
// the designation ("ASCE 7-22", "ASHRAE 90.1-2019", "NFPA 70, 2023 edition", a title
// then the year) or directly before it ("the 2023 edition of the National Electrical
// Code") when no other edition follows. A conservative guard, not legal interpretation.
function standardEdition(quote,id,edition,pageOrSection=''){
  const year=String(edition).match(/\b(?:19|20)\d{2}\b/)?.[0];if(!year)return false;
  quote=metricTwin(String(quote).normalize('NFC'));
  const match=designationPattern(id).exec(quote),{pub,num}=parts(id);
  if(!match){
    // A publisher's reference table may list compact rows such as "318—19"; the
    // citation must identify that table.
    return new RegExp(`${pub}.*(?:table|referenc)|(?:table|referenc).*${pub}`,'i').test(pageOrSection)&&new RegExp('(?:^|[^\\w.])'+escape(num)+'\\s*[-–—]\\s*(?:'+year+'|'+year.slice(2)+')\\b','i').test(quote);
  }
  const tail=beforeNextReference(quote.slice(match.index+match[0].length,match.index+240),id);
  if(new RegExp('^\\s*(?:[-–—,(|:]\\s*)?'+year+'\\b').test(tail)||new RegExp('^\\s*[-–—:]\\s*'+year.slice(2)+'\\b').test(tail))return true;
  if(new RegExp('(?:^|[^\\w])(?:'+year+'\\s+[ée]dition|[ée]dition\\s*[:(]?\\s*'+year+')(?![\\w])','i').test(tail))return true;
  const titled=new RegExp('^[\\s,(|]*([A-Za-z][^;\\n\\d|]{1,140}?)\\s*[-–—,(|:]\\s*'+year+'\\b','i').exec(tail);
  if(titled&&!/\b(adopt\w*|ordinance|effective|amend\w*|referenc\w*|under|pursuant|dated|resolution|published)\b/i.test(titled[1]))return true;
  const before=quote.slice(0,match.index),leading=new RegExp('(^|[^\\w.-])'+year+'\\s+(?:edition\\s+of\\s+(?:the\\s+)?)?$','i').exec(before);
  return Boolean(leading)&&!/^\s*[-–—:,(]?\s*\d/.test(tail)&&!new RegExp(`(?:${PARENTS})\\s*$`,'i').test(before.slice(0,leading.index+leading[1].length));
}

function country(input){return countryName(input.country)==='Canada'?'ca':'us';}
function matchedProfiles(input={}){return isFireProtection(input)?[]:PROFILES.filter(p=>p.match.test(input.discipline||''));}
const listed=items=>items.length<3?items.join(' and '):items.slice(0,-1).join(', ')+' and '+items.at(-1);
function disciplineTargets(input,profiles){
  const where=country(input),answers=(input.questionResponses||[]).filter(q=>q.status==='answered').map(q=>q.answer);
  const context=[input.scope,input.occupancy,input.notes,...answers].filter(Boolean).join(' '),rows=new Map();
  for(const p of profiles)for(const [standard,topic] of p[where].core)if(!rows.has(standard))rows.set(standard,{standard,topic,trigger:'Baseline screening; confirm scope and legal applicability.'});
  for(const p of profiles)for(const [pattern,us,ca] of p.groups)if(pattern.test(context))for(const [standard,topic] of where==='ca'?ca:us)rows.set(standard,{standard,topic,trigger:'Screen because of the project use or systems mentioned; presence is not assumed.'});
  for(const standard of standardIds(context))if(!rows.has(standard))rows.set(standard,{standard,topic:'Standard mentioned in project context',trigger:'User-specified research target.'});
  return [...rows.values()];
}
// One profile per project: fire protection keeps its NFPA profile; another discipline
// (or a custom one such as "MEP") combines the profiles its name matches. null when none.
export function screeningProfile(input={}){
  if(isFireProtection(input)){
    const targets=fireProfile(input);
    return {id:'fire_protection',fire:true,label:'Fire protection',title:'NFPA standards',checklist:'NFPA',rowsKey:'fireStandards',summaryKey:'fireProtection',version:FIRE_PROFILE_VERSION,targets,
      ids:nfpaIds,single:individualStandard,row:checklistStandard,edition:(quote,id,edition,pageOrSection)=>nfpaEdition(quote,id,edition,/NFPA.*(?:table|referenc)|(?:table|referenc).*NFPA/i.test(pageOrSection||'')),
      examples:'NFPA 13 or CAN/ULC-S524',reviewer:'Fire protection reviewer',authority:'Responsible fire protection AHJ',contact:'Fire protection AHJ'};
  }
  const profiles=matchedProfiles(input);if(!profiles.length)return null;
  const where=country(input),text=key=>profiles.map(p=>p[where][key]);
  return {id:profiles.map(p=>p.id).join('+'),fire:false,label:listed(profiles.map(p=>p.label)).replace(/(?<=.) [A-Z]/g,s=>s.toLowerCase()),title:'Referenced standards',checklist:'standards',rowsKey:'standards',summaryKey:'screening',version:SCREENING_PROFILE_VERSION,targets:disciplineTargets(input,profiles),
    ids:standardIds,single:singleStandard,row:value=>checklistRow(value,text('examples')[0]),edition:standardEdition,
    examples:text('examples')[0],grouped:text('grouped')[0],hint:[...new Set(text('hint'))].join('; '),models:[...new Set(text('models'))].join('; '),screen:[...new Set(text('screen'))].join(' '),offices:profiles.map(p=>p.offices).join('; '),
    reviewer:'Responsible plan reviewer',authority:'Responsible AHJ',contact:'Responsible AHJ'};
}
// The targets alone, for the project view and exports.
export function screeningView(input={}){
  const profile=screeningProfile(input);if(!profile)return null;
  const {id,fire,label,title,checklist,rowsKey,summaryKey,version,targets}=profile;
  return {id,fire,label,title,checklist,rowsKey,summaryKey,version,targets};
}
// The contacts assignment names the offices a discipline deals with. Fire protection and
// unmatched disciplines keep the original list, which names the Fire Marshal.
export function contactOffices(input={}){return screeningProfile(input)?.offices||'';}

export function screeningInstructions(input,{review=false}={}){
  const profile=screeningProfile(input);if(!profile)return '';
  if(profile.fire)return fireInstructions(input,{review});
  return `\n${profile.label.toUpperCase()} STANDARDS COVERAGE (version ${profile.version}):\n${profile.targets.map(p=>`${p.standard} | ${p.topic} | ${p.trigger}`).join('\n')}
This is a screening checklist, NOT a list of adopted or necessarily applicable standards. ${review?'Assess every target separately against saved evidence; retain additional relevant standards identified in that evidence.':'Research every target separately; add other standards discovered in authoritative references when relevant.'} ${profile.screen} Do not call a standard not_applicable merely because a search found nothing. Missing scope or adoption evidence means conditional or unresolved.
Prioritize the official adoption instrument, amendments, and referenced-standards chapter (for example ${profile.hint}). ${review?'Check available saved passages for the adoption chain and edition table; record a specific gap where that evidence is missing.':'Read discovered official documents before declaring them unavailable. Efficiently extract multiple edition rows from the same reference table; do not run a separate broad search for every standard. Respect access restrictions and use legitimate official alternatives.'} An amendment booklet may omit unchanged model-code references. Trace those to the incorporated model edition and its reference table; do not infer their years. Check table headers, row labels and footnotes so an adjacent standard or parent-code year is not assigned to the target. A catalog/current-edition page is not adoption evidence. A search snippet or another agent's claim is not evidence.
For EACH standard identify applicability (applicable, conditional, not_applicable or unresolved), exact edition if established, direct/referenced/guidance/unconfirmed basis, parent code AND edition/reference section, adoption authority/instrument, effective date, amendments, relevant short quotations with source IDs, and any system/scope facts needed. Distinguish design and installation requirements from ongoing operation, inspection and maintenance, owner preferences from law, and future adoption proposals from the currently effective rules. Never use a grouped entry like '${profile.grouped}' as coverage. Different editions for different legal uses require separate rows and an explanation; do not collapse a conflict.
${review?`Put individual screened standard rows in standards, not codes. Start name with the exact designation (publisher and number, such as ${profile.examples}). standards uses the codes fields plus applicabilityStatus, adoptionSourceId and editionSourceId. For a source-supported applicable/conditional edition, cite BOTH the legal adoption chain (adoptionSourceId) and the standard's designation with its edition (editionSourceId); they may be the same source if it proves both. Both IDs must identify evidence quotations in this row. Keep governing model codes (${profile.models}) in codes. Include every screening target, even if unresolved or not_applicable, with the concrete reason and next step in applicability/notes. A missing edition stays blank. Do not label the whole codes area supported while relevant editions remain unresolved.`:`When finishing, include standards: one check per target, plus relevant discoveries. Each check has standard (one designation only, such as ${profile.examples}), applicability (applicable/conditional/not_applicable/unresolved), and finding (edition and source IDs/adoption chain, or the specific missing evidence/scope and next step). Preserve these details in the brief. Mark codes unresolved when any relevant edition/adoption chain is unverified; naming the governing code is not completion of the standards research.`}`;
}

export function screeningCompletionError(input,projectInput){
  input=normalizeCompletion(input);
  const profile=screeningProfile(projectInput);if(!profile?.targets.length)return '';
  const checks=input?.standards,what=profile.fire?'NFPA':'screening';
  if(!Array.isArray(checks))return `Include the standards checklist in finish_research. Every required ${what} target needs a separate finding, even when unresolved.`;
  // Name each rejected row. A generic message let the model resend the same
  // CAN/ULC row until the stage ran out of rounds.
  const problems=checks.map(c=>{
    const issues=[profile.row(c?.standard).error,APPLICABILITY.includes(c?.applicability)?'':'an applicability of '+APPLICABILITY.join('/'),typeof c?.finding==='string'&&c.finding.trim().length>=24?'':'a substantive finding'].filter(Boolean);
    return issues.length?`"${String(c?.standard??'').trim().slice(0,80)||'(blank)'}" needs ${issues.join(' and ')}`:'';
  }).filter(Boolean);
  if(problems.length)return 'Standards checks to fix: '+problems.slice(0,6).join('; ')+(problems.length>6?`; and ${problems.length-6} more`:'')+`. Put one designation in standard (for example ${profile.examples}), the edition/adoption evidence or the missing fact and next step in finding, and keep every other row.`;
  const missing=profile.targets.filter(t=>!checks.some(c=>profile.row(c.standard).standard===t.standard));
  if(missing.length)return `The ${profile.fire?'NFPA':'standards'} checklist is missing `+missing.map(t=>t.standard).join(', ')+'. Research them or record the specific unresolved question and next step separately.';
  if(checks.some(c=>c.applicability==='unresolved')&&input.coverage?.codes==='supported')return `${profile.fire?'NFPA':'Standards'} checks remain unresolved. Set codes coverage to unresolved and preserve the specific gaps.`;
  return '';
}

const compact=text=>String(text||'').toLowerCase().replace(/[^a-z0-9]/g,'');
// A report row may omit an edition suffix: CAN/ULC-S524 covers CAN/ULC-S524-19.
const designationKeys=designation=>[...new Set([designation,designation.replace(/(?<=[A-Z]\d+)-(?:19|20)?\d{2}$/,'')].map(compact))];
const CHECKLIST_LINE=/^([^|\n]+?) \| (?:applicable|conditional|unresolved|not_applicable) \| /gm;
const checklistSections=stages=>stages.filter(s=>['codes','verification'].includes(s.id)).flatMap(stage=>String(stage.output||'').split(/\n(?:STANDARDS|NFPA) CHECKLIST\n/).slice(1));
// Checklist rows the research stages recorded: rows the report section holds become
// targets; other designations ("CSA C282" on an NFPA profile, an unlisted publisher)
// need a finding somewhere in the report or a confirmation question.
function stageChecklist(profile,stages){
  const targets=[],discoveries=new Map();
  if(profile.fire){
    for(const stage of stages.filter(s=>['codes','verification'].includes(s.id)))for(const match of String(stage.output||'').matchAll(/^(NFPA \d{1,4}[A-Z]?) \| (?:applicable|conditional|unresolved|not_applicable) \| /gm))targets.push(match[1]);
  }
  for(const section of checklistSections(stages))for(const match of section.matchAll(CHECKLIST_LINE)){
    const {standard}=profile.row(match[1]);if(!standard)continue;
    if(profile.ids(standard).length){if(!profile.fire)targets.push(profile.ids(standard)[0]);continue;}
    const designation=standard.match(/^.*?\d[\w.]*(?:-\d+)*/)[0];discoveries.set(compact(designation),designation);
  }
  return {targets,discoveries:[...discoveries.values()]};
}
// An exact quote match alone does not establish that a quoted year belongs to this
// standard. Require the designation and edition together, and an explicit adoption-source
// link. Rows of the section the project does not use were folded into codes earlier.
export function validateScreening(report,input,validate,stages=[],savedResponses=input?.questionResponses||[]){
  const profile=screeningProfile(input);if(!profile){delete report.fireStandards;delete report.standards;return;}
  const targets=[...profile.targets],found=stageChecklist(profile,stages);
  for(const standard of found.targets)if(!targets.some(t=>t.standard===standard))targets.push({standard,topic:'Additional standard identified during research',trigger:'A research-stage checklist identified this standard; retain and verify its finding.'});
  const rows=Array.isArray(report[profile.rowsKey])?report[profile.rowsKey]:[];
  // Accept old/simpler model output, but never count a grouped row as coverage.
  report.codes=report.codes.filter(c=>{if(profile.ids(c.name).length){rows.push(c);return false;}return true;});
  const validated=[];
  for(const row of rows){
    const ids=profile.ids(row.name);if(!profile.single(row.name)){const question=`Separate the grouped ${profile.fire?'NFPA':'standards'} finding: `+String(row.name||'Unnamed standard');if(!report.gaps.some(g=>g.question===question)&&!resolvedCovers(savedResponses,{question}))report.gaps.push({question,why:'A grouped entry cannot establish individual editions.',contact:row.authority||profile.reviewer,nextStep:'Obtain one edition and adoption chain for each referenced standard.'});continue;}
    row.applicabilityStatus=normalizeEnum(row.applicabilityStatus,APPLICABILITY);
    row.applicabilityStatus=APPLICABILITY.includes(row.applicabilityStatus)?row.applicabilityStatus:'unresolved';
    validate(row,row.applicabilityStatus==='not_applicable'?'Screening':'Code');
    if(row.applicabilityStatus==='not_applicable'&&(!row.applicability?.trim()||!row.evidence.some(e=>e.supported))){row.applicabilityStatus='unresolved';row.notes=(row.notes||'')+' Exclusion needs a documented scope or adoption basis.';}
    const adoption=row.evidence.some(e=>e.supported&&e.sourceId===row.adoptionSourceId);
    const edition=row.evidence.some(e=>e.supported&&e.sourceId===row.editionSourceId&&profile.edition(e.quote,ids[0],row.edition,e.pageOrSection));
    if(row.applicabilityStatus!=='not_applicable'&&(!adoption||!edition||!['direct','referenced'].includes(row.adoptionType)||!row.adoptionInstrument?.trim())){
      if(row.status!=='conflicting')row.status='unverified';
      const reasons=[!adoption?'a supporting adoption-chain quotation is missing':'',!edition?'a matching quotation for this standard and edition is missing':'',!['direct','referenced'].includes(row.adoptionType)?'guidance or unconfirmed adoption does not establish an adopted edition':'',!row.adoptionInstrument?.trim()?'the adoption instrument is unspecified':''].filter(Boolean);
      row.notes=(row.notes||'')+' Adoption evidence check: '+reasons.join('; ')+'.';
    }
    if(row.applicabilityStatus==='unresolved'&&row.status!=='conflicting')row.status='unverified';
    if(report.jurisdiction.status!=='verified'&&row.status==='verified'&&row.applicabilityStatus!=='not_applicable')row.status='inferred';
    validated.push(row);
  }
  for(const target of targets)if(!validated.some(r=>profile.ids(r.name)[0]===target.standard))validated.push({name:target.standard+' — '+target.topic,edition:'',authority:profile.authority,adoptionType:'unconfirmed',adoptionInstrument:'',effectiveDate:'',amendments:'',applicability:'Screening required. '+target.trigger,notes:'This standard was omitted from the final research findings. Confirm its applicability and adopted edition.',status:'unverified',applicabilityStatus:'unresolved',adoptionSourceId:'',editionSourceId:'',evidence:[]});
  const unresolved=validated.filter(r=>r.applicabilityStatus!=='not_applicable'&&(r.status!=='verified'||r.applicabilityStatus!=='applicable'));
  const savedCovers=(id,question)=>report.gaps.some(g=>profile.ids(g.question).includes(id))||resolvedCovers(savedResponses,{question})||savedResponses.some(response=>isResolvedStatus(response.status)&&profile.ids(resolvedQuestionText(response)).includes(id));
  for(const row of unresolved){const id=profile.ids(row.name)[0];const question=`Confirm ${id}: applicability and adopted edition.`;if(!savedCovers(id,question))report.gaps.push({question,why:row.notes||row.applicability,contact:row.authority||profile.contact,nextStep:'Obtain the reference-table entry, adoption instrument and amendments; confirm any missing system details with the project team.'});}
  // A referenced standard that research checked but the report omits gets the same
  // follow-up an omitted target gets.
  for(const designation of found.discoveries){
    const keys=designationKeys(designation),mentions=text=>keys.some(key=>compact(text).includes(key)),question=`Confirm ${designation}: applicability and adopted edition.`;
    const covered=[...report.codes.map(c=>c.name),...validated.map(r=>r.name),...report.gaps.map(g=>g.question)].some(mentions)||resolvedCovers(savedResponses,{question})||savedResponses.some(response=>isResolvedStatus(response.status)&&mentions(resolvedQuestionText(response)));
    if(!covered)report.gaps.push({question,why:'A research-stage standards checklist identified this standard, but the final report has no finding for it.',contact:'Responsible AHJ',nextStep:'Obtain the referenced-documents table entry, adoption instrument and edition, and confirm whether the project scope triggers it.'});
  }
  report[profile.rowsKey]=validated;
  report[profile.summaryKey]={...(profile.fire?{}:{profile:profile.id,label:profile.label}),profileVersion:profile.version,targets:targets.map(t=>t.standard),unresolved:unresolved.length,scopeConditional:validated.filter(r=>r.applicabilityStatus==='conditional').length,applicabilityUnresolved:validated.filter(r=>r.applicabilityStatus==='unresolved').length,evidenceUnresolved:validated.filter(r=>r.applicabilityStatus!=='not_applicable'&&r.status!=='verified').length};
  report.coverage??={};report.coverage.codes=profile.fire?`Fire protection: ${validated.length} individual NFPA findings; ${unresolved.length} need confirmation. Governing-code findings are listed separately.`:`${profile.label}: ${validated.length} individual standard findings; ${unresolved.length} need confirmation. Governing-code findings are listed separately.`;
}
