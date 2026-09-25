// The Porter stemmer (M.F. Porter, 1980), as published, so "raises",
// "raised" and "raising" all read as "rais". No dependency.

const step2list: Record<string, string> = {
  ational: "ate",
  tional: "tion",
  enci: "ence",
  anci: "ance",
  izer: "ize",
  bli: "ble",
  alli: "al",
  entli: "ent",
  eli: "e",
  ousli: "ous",
  ization: "ize",
  ation: "ate",
  ator: "ate",
  alism: "al",
  iveness: "ive",
  fulness: "ful",
  ousness: "ous",
  aliti: "al",
  iviti: "ive",
  biliti: "ble",
  logi: "log",
};

const step3list: Record<string, string> = {
  icate: "ic",
  ative: "",
  alize: "al",
  iciti: "ic",
  ical: "ic",
  ful: "",
  ness: "",
};

const c = "[^aeiou]";
const v = "[aeiouy]";
const C = c + "[^aeiouy]*";
const V = v + "[aeiou]*";
const mgr0 = new RegExp("^(" + C + ")?" + V + C);
const meq1 = new RegExp("^(" + C + ")?" + V + C + "(" + V + ")?$");
const mgr1 = new RegExp("^(" + C + ")?" + V + C + V + C);
const sV = new RegExp("^(" + C + ")?" + v);

export function stem(input: string): string {
  let w = input;
  if (w.length < 3) return w;
  let fp: RegExpExecArray | null;
  let re: RegExp;
  let re2: RegExp;
  let re3: RegExp;
  let re4: RegExp;
  let stemPart: string;
  let suffix: string;

  const firstch = w.substring(0, 1);
  if (firstch === "y") w = firstch.toUpperCase() + w.substring(1);

  // Step 1a
  re = /^(.+?)(ss|i)es$/;
  re2 = /^(.+?)([^s])s$/;
  if (re.test(w)) w = w.replace(re, "$1$2");
  else if (re2.test(w)) w = w.replace(re2, "$1$2");

  // Step 1b
  re = /^(.+?)eed$/;
  re2 = /^(.+?)(ed|ing)$/;
  if (re.test(w)) {
    fp = re.exec(w)!;
    if (mgr0.test(fp[1])) w = w.replace(/.$/, "");
  } else if (re2.test(w)) {
    fp = re2.exec(w)!;
    stemPart = fp[1];
    if (sV.test(stemPart)) {
      w = stemPart;
      re2 = /(at|bl|iz)$/;
      re3 = new RegExp("([^aeiouylsz])\\1$");
      re4 = new RegExp("^" + C + v + "[^aeiouwxy]$");
      if (re2.test(w)) w = w + "e";
      else if (re3.test(w)) w = w.replace(/.$/, "");
      else if (re4.test(w)) w = w + "e";
    }
  }

  // Step 1c
  re = /^(.+?)y$/;
  if (re.test(w)) {
    fp = re.exec(w)!;
    stemPart = fp[1];
    if (sV.test(stemPart)) w = stemPart + "i";
  }

  // Step 2
  re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  if (re.test(w)) {
    fp = re.exec(w)!;
    stemPart = fp[1];
    suffix = fp[2];
    if (mgr0.test(stemPart)) w = stemPart + step2list[suffix];
  }

  // Step 3
  re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  if (re.test(w)) {
    fp = re.exec(w)!;
    stemPart = fp[1];
    suffix = fp[2];
    if (mgr0.test(stemPart)) w = stemPart + step3list[suffix];
  }

  // Step 4
  re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  re2 = /^(.+?)(s|t)(ion)$/;
  if (re.test(w)) {
    fp = re.exec(w)!;
    stemPart = fp[1];
    if (mgr1.test(stemPart)) w = stemPart;
  } else if (re2.test(w)) {
    fp = re2.exec(w)!;
    stemPart = fp[1] + fp[2];
    if (mgr1.test(stemPart)) w = stemPart;
  }

  // Step 5
  re = /^(.+?)e$/;
  if (re.test(w)) {
    fp = re.exec(w)!;
    stemPart = fp[1];
    re = mgr1;
    re2 = meq1;
    re3 = new RegExp("^" + C + v + "[^aeiouwxy]$");
    if (re.test(stemPart) || (re2.test(stemPart) && !re3.test(stemPart))) w = stemPart;
  }

  re = /ll$/;
  if (re.test(w) && mgr1.test(w)) w = w.replace(/.$/, "");

  if (firstch === "y") w = firstch.toLowerCase() + w.substring(1);
  return w;
}
