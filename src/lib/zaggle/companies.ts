/**
 * Zaggle SDE 1 screening — employers that are IT services, consulting or staffing
 * firms. The JD rules them out ("No consulting or IT services background"), so a
 * name on this list is classified here, deterministically, whatever the model said.
 * Employers not on the list are classified by the model from the resume (with its
 * reason) — e.g. a small agency that "built websites for clients" is IT services.
 * Pure (no I/O).
 */

export type FirmKind = "it-services" | "consulting" | "staffing";

/** [pattern, canonical name, kind]. Patterns match whole words in the employer name. */
const FIRMS: [RegExp, string, FirmKind][] = [
  [/\b(tcs|tata consultancy)\b/i, "TCS", "it-services"],
  [/\binfosys\b(?!.*\bfinacle\b)/i, "Infosys", "it-services"],
  [/\bwipro\b/i, "Wipro", "it-services"],
  [/\bhcl\s*(tech|technologies|tech\b)?\b|\bhcltech\b/i, "HCLTech", "it-services"],
  [/\btech\s*mahindra\b/i, "Tech Mahindra", "it-services"],
  [/\bcognizant\b|\bcts\b/i, "Cognizant", "it-services"],
  [/\baccenture\b/i, "Accenture", "consulting"],
  [/\bcapgemini\b/i, "Capgemini", "it-services"],
  [/\b(ltimindtree|lti\s*mindtree|l\s*&\s*t\s*infotech|larsen\s*&?\s*toubro\s*infotech|mindtree)\b|\blti\b/i, "LTIMindtree", "it-services"],
  [/\b(l\s*&\s*t\s*technology\s*services|ltts)\b/i, "L&T Technology Services", "it-services"],
  [/\bmphasis\b/i, "Mphasis", "it-services"],
  [/\bhexaware\b/i, "Hexaware", "it-services"],
  [/\bpersistent\s*systems?\b/i, "Persistent Systems", "it-services"],
  [/\bbirlasoft\b/i, "Birlasoft", "it-services"],
  [/\bzensar\b/i, "Zensar", "it-services"],
  [/\b(coforge|niit\s*technologies)\b/i, "Coforge", "it-services"],
  [/\bcyient\b/i, "Cyient", "it-services"],
  [/\bsonata\s*software\b/i, "Sonata Software", "it-services"],
  [/\bvirtusa\b/i, "Virtusa", "it-services"],
  [/\bdxc\b/i, "DXC Technology", "it-services"],
  [/\bntt\s*data\b/i, "NTT DATA", "it-services"],
  [/\bgenpact\b/i, "Genpact", "it-services"],
  [/\bmastek\b/i, "Mastek", "it-services"],
  [/\bhappiest\s*minds\b/i, "Happiest Minds", "it-services"],
  [/\binfogain\b/i, "Infogain", "it-services"],
  [/\bust(\s*global)?\b/i, "UST", "it-services"],
  [/\bcgi\b/i, "CGI", "it-services"],
  [/\batos\b/i, "Atos", "it-services"],
  [/\bsyntel\b/i, "Syntel", "it-services"],
  [/\bigate\b/i, "iGate", "it-services"],
  [/\bxoriant\b/i, "Xoriant", "it-services"],
  [/\bglobal\s*logic\b|\bgloballogic\b/i, "GlobalLogic", "it-services"],
  [/\bepam\b/i, "EPAM", "it-services"],
  [/\bnagarro\b/i, "Nagarro", "it-services"],
  [/\baltimetrik\b/i, "Altimetrik", "it-services"],
  [/\bsasken\b/i, "Sasken", "it-services"],
  [/\bkpit\b/i, "KPIT", "it-services"],
  [/\btata\s*elxsi\b/i, "Tata Elxsi", "it-services"],
  [/\bquest\s*global\b/i, "Quest Global", "it-services"],
  [/\bexpleo\b/i, "Expleo", "it-services"],
  [/\bimpetus\b/i, "Impetus", "it-services"],
  [/\binfobeans\b/i, "InfoBeans", "it-services"],
  [/\bkellton\b/i, "Kellton", "it-services"],
  [/\bqburst\b/i, "QBurst", "it-services"],
  [/\bmu\s*sigma\b/i, "Mu Sigma", "it-services"],
  [/\bthoughtworks\b/i, "Thoughtworks", "consulting"],
  [/\bpublicis\s*sapient\b|\bsapient\b/i, "Publicis Sapient", "consulting"],
  [/\bdeloitte\b/i, "Deloitte", "consulting"],
  [/\b(ey|ernst\s*&?\s*young)\b/i, "EY", "consulting"],
  [/\bkpmg\b/i, "KPMG", "consulting"],
  [/\b(pwc|pricewaterhouse\s*coopers|price\s*waterhouse)\b/i, "PwC", "consulting"],
  [/\b(mckinsey|boston consulting group|bcg|bain)\b/i, "Management consulting", "consulting"],
  [/\b(quess|teamlease|randstad|adecco|manpower\s*group|manpowergroup|ciel\s*hr|xpheno)\b/i, "Staffing firm", "staffing"],
];

/** The firm an employer name belongs to, or null when it isn't on the list. */
export function knownServicesFirm(employer: string): { name: string; kind: FirmKind } | null {
  const e = (employer ?? "").trim();
  if (!e) return null;
  for (const [re, name, kind] of FIRMS) if (re.test(e)) return { name, kind };
  return null;
}

/** Every firm on the list, for the screen's "what counts as IT services" note. */
export const KNOWN_SERVICES_FIRMS = Array.from(new Set(FIRMS.map(([, n]) => n)));
