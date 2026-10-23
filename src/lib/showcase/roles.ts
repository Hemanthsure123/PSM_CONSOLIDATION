/**
 * Sample profiles — the role catalogue. Each role is proven by technologies the code (or the
 * resume's own technology list) shows, from the github-analysis catalogue keys, plus file paths /
 * dependencies for roles that catalogue doesn't model (Web3, game engines, firmware, security).
 * Pure: shared by the server (prompt, verification) and the browser (assignment).
 */

export interface SpRoleDef {
  key: string;
  label: string;
  /** Catalogue keys that prove the role (any one, unless `rule` says otherwise). */
  keys: string[];
  /** Repo paths / dependencies that prove it where the catalogue has no key. */
  paths?: RegExp[];
  deps?: RegExp[];
  /** For the reader's rubric: what makes a project in this role production-grade… */
  advanced: string;
  /** …and what is basic / tutorial-level here. */
  basic: string;
}

export const SP_ROLES: SpRoleDef[] = [
  {
    key: "frontend",
    label: "Frontend Engineer",
    keys: ["react", "angular", "vue", "html-css"],
    advanced: "state management at scale, performance (code-splitting, memoisation, virtual lists), accessibility, design systems, SSR / Next.js, testing, real-time UI, complex client logic",
    basic: "static pages, portfolio sites, landing pages, simple UI clones, course apps",
  },
  {
    key: "backend",
    label: "Backend Engineer",
    keys: ["nodejs", "django", "fastapi-or-flask", "spring-boot", "dotnet", "go", "php", "laravel", "ruby", "rails", "rust"],
    advanced: "service design, auth, databases with indexing / transactions, caching (Redis), queues (Kafka / RabbitMQ), concurrency, rate limiting, observability, deployment, measured performance",
    basic: "single-table CRUD APIs, tutorial REST examples with no data design",
  },
  {
    key: "fullstack",
    label: "Full Stack Developer",
    keys: [],
    advanced: "a product built end to end — UI, own API and database, auth, deployment, real users, realtime or payments, tests / CI",
    basic: "course full-stack apps, CRUD clones (todo / notes / blog) with no own design",
  },
  {
    key: "mobile",
    label: "Mobile App Developer",
    keys: ["android", "react-native", "flutter", "swift-ios", "android-architecture", "app-release"],
    advanced: "Play Store / App Store release, offline sync, architecture (MVVM, Jetpack, DI), background work, push notifications, native modules, performance",
    basic: "single-screen demo apps, calculator / to-do apps, course exercises",
  },
  {
    key: "genai",
    label: "Generative AI Engineer",
    keys: ["llm", "llm-finetuning", "llm-inference"],
    advanced: "RAG with retrieval evaluation, agents with tools, fine-tuning, guardrails, latency / cost optimisation, evaluation harnesses, production deployment",
    basic: "a chatbot that only forwards prompts to an API, prompt playgrounds",
  },
  {
    key: "aiml",
    label: "AI / ML Engineer",
    keys: ["pytorch", "tensorflow", "transformers", "huggingface", "image-analysis", "nlp"],
    advanced: "model training with proper evaluation, deep learning architectures, data pipelines, deployment / serving, error analysis, beating a baseline",
    basic: "running a pretrained model on sample data, Kaggle notebook copies, iris / titanic tutorials",
  },
  {
    key: "data-science",
    label: "Data Scientist",
    keys: ["scikit-learn", "machine-learning", "model-evaluation", "time-series"],
    advanced: "feature engineering, model selection with validation, experiment design, forecasting with backtests, explainability, business impact",
    basic: "EDA-only notebooks, tutorial datasets with default models",
  },
  {
    key: "data-analyst",
    label: "Data Analyst",
    keys: ["powerbi", "tableau", "excel", "data-viz", "pandas"],
    advanced: "dashboards used by a business, SQL over real data, KPI design, automation of reporting, statistical analysis",
    basic: "one-off charts of a public dataset",
  },
  {
    key: "data-engineering",
    label: "Data Engineer",
    keys: ["spark", "kafka"],
    paths: [/(?:^|\/)dags\/.+\.py$/i, /(?:^|\/)dbt_project\.yml$/i],
    deps: [/^apache-airflow$/i, /^dbt-/i, /^pyspark$/i, /^kafka-python$/i, /^confluent-kafka$/i],
    advanced: "batch / streaming pipelines, orchestration, data modelling, data quality checks, warehouse loads at volume",
    basic: "a script that copies a CSV into a database",
  },
  {
    key: "devops-cloud",
    label: "DevOps / Cloud Engineer",
    keys: ["kubernetes", "terraform"],
    paths: [/(?:^|\/)helm\/|Chart\.yaml$/i, /(?:^|\/)k8s\/.+\.ya?ml$/i, /\.tf$/i, /(?:^|\/)ansible\//i],
    advanced: "infrastructure as code, Kubernetes deployments, CI/CD pipelines, monitoring / alerting, autoscaling, cost / reliability work",
    basic: "a Dockerfile added to a web app",
  },
  {
    key: "sdet-qa",
    label: "SDET / QA Automation",
    keys: ["selenium", "playwright", "cypress", "appium", "api-testing", "performance-testing", "test-automation", "bdd"],
    advanced: "test frameworks (page objects, data-driven), CI integration, API / performance / mobile automation, reporting",
    basic: "a handful of recorded UI tests",
  },
  {
    key: "embedded-iot",
    label: "Embedded / IoT Engineer",
    keys: [],
    paths: [/\.ino$/i, /(?:^|\/)platformio\.ini$/i, /(?:^|\/)sdkconfig$/i, /(?:^|\/)CMakeLists\.txt$/i],
    deps: [/freertos/i, /esp-idf/i, /arduino/i],
    advanced: "firmware on real hardware, RTOS, drivers / protocols (I2C, SPI, CAN, MQTT), power / memory optimisation",
    basic: "blinking an LED, single-sensor Arduino sketches",
  },
  {
    key: "blockchain",
    label: "Blockchain / Web3 Developer",
    keys: [],
    paths: [/\.sol$/i, /(?:^|\/)hardhat\.config\.[jt]s$/i, /(?:^|\/)truffle-config\.js$/i, /(?:^|\/)foundry\.toml$/i],
    deps: [/^ethers$/i, /^web3$/i, /^hardhat$/i, /^@openzeppelin\//i],
    advanced: "smart contracts with tests and audits, DeFi / NFT logic, gas optimisation, dApps on a testnet / mainnet",
    basic: "a copied ERC-20 token tutorial",
  },
  {
    key: "game-dev",
    label: "Game Developer",
    keys: [],
    paths: [/(?:^|\/)ProjectSettings\//, /\.uproject$/i, /(?:^|\/)project\.godot$/i],
    deps: [/^pygame$/i, /^phaser$/i, /^three$/i],
    advanced: "game engines (Unity / Unreal / Godot), physics, multiplayer, shaders, published builds",
    basic: "tic-tac-toe, snake, simple browser games",
  },
  {
    key: "cybersecurity",
    label: "Cybersecurity Engineer",
    keys: [],
    deps: [/^scapy$/i, /^pwntools$/i, /^yara-python$/i, /^impacket$/i],
    advanced: "vulnerability research, CTF results, security tooling, network / malware analysis, secure-by-design systems",
    basic: "a password generator, a caesar-cipher script",
  },
  {
    key: "sde",
    label: "SDE (Software Engineer)",
    keys: ["c-cpp", "java", "go", "rust"],
    advanced: "systems projects (databases, compilers, networking, OS), strong engineering across stacks, elite competitive programming",
    basic: "DSA practice repos",
  },
];

export const SP_ROLE: Record<string, SpRoleDef> = Object.fromEntries(SP_ROLES.map((r) => [r.key, r]));
export const SP_ROLE_KEYS = SP_ROLES.map((r) => r.key);

export function roleLabel(key: string): string {
  if (SP_ROLE[key]) return SP_ROLE[key].label;
  if (key.startsWith("other:")) return key.slice(6).replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  return key;
}

/** Free-text roles the model names → catalogue roles (or a normalised "other:<role>"). */
const SYNONYMS: [RegExp, string][] = [
  [/full[\s-]*stack|mern|mean stack/i, "fullstack"],
  [/front[\s-]*end|ui engineer|react developer|web ui/i, "frontend"],
  [/back[\s-]*end|api developer|server[\s-]*side/i, "backend"],
  [/android|ios|mobile|flutter|react native|kotlin|swift/i, "mobile"],
  [/gen(?:erative)?[\s-]*ai|llm|rag|agentic|prompt/i, "genai"],
  [/data engineer|etl|pipeline|big data/i, "data-engineering"],
  [/data scien|machine learning engineer|ml engineer|predictive/i, "data-science"],
  [/data analy|business intelligence|\bbi\b|power ?bi|tableau/i, "data-analyst"],
  [/\bai\b|ml\b|deep learning|computer vision|\bcv\b|nlp|vision/i, "aiml"],
  [/devops|cloud|sre|site reliability|platform engineer|infra/i, "devops-cloud"],
  [/qa|sdet|test automation|testing/i, "sdet-qa"],
  [/embedded|iot|firmware|robotics|hardware/i, "embedded-iot"],
  [/blockchain|web3|smart contract|solidity/i, "blockchain"],
  [/game/i, "game-dev"],
  [/security|cyber|pentest|ethical hack/i, "cybersecurity"],
  [/sde|software (?:development )?engineer|software developer|systems/i, "sde"],
];

export function normaliseRole(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (SP_ROLE[s.toLowerCase()]) return s.toLowerCase();
  for (const [re, key] of SYNONYMS) if (re.test(s)) return key;
  const slug = s.toLowerCase().replace(/[^a-z0-9 /+-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return slug ? `other:${slug}` : "";
}

// ── Which roles a project's technologies prove ──────────────────────────────

const has = (keys: Set<string>, list: string[]) => list.some((k) => keys.has(k));
const FE_UI = ["react", "angular", "vue"];
const BE_SERVER = ["nodejs", "django", "fastapi-or-flask", "spring-boot", "dotnet", "go", "php", "laravel", "ruby", "rails"];
const DB = ["sql", "mongodb", "redis"];
const DEEP = ["pytorch", "tensorflow", "transformers", "huggingface", "image-analysis", "nlp"];

/**
 * The roles a set of technology keys (+ repo paths / dependencies, when known) proves, most
 * specific first. Full stack = a UI framework + an own server + a database; GenAI beats AI/ML
 * beats Data Science beats Data Analyst; React Native is mobile, not web frontend.
 */
export function rolesFromEvidence(techKeys: string[], paths: string[] = [], deps: string[] = []): string[] {
  const k = new Set(techKeys);
  if (k.has("react-native")) k.delete("react");
  const out: string[] = [];
  const add = (r: string) => !out.includes(r) && out.push(r);
  if (has(k, SP_ROLE.genai.keys)) add("genai");
  if (has(k, DEEP)) add("aiml");
  if (has(k, SP_ROLE["data-science"].keys) && !has(k, DEEP)) add("data-science");
  if (has(k, SP_ROLE.mobile.keys)) add("mobile");
  const fe = has(k, FE_UI) || (k.has("html-css") && k.has("javascript") && !has(k, BE_SERVER));
  const be = has(k, BE_SERVER);
  if (fe && be && has(k, DB)) add("fullstack");
  else if (fe && be) add("fullstack");
  else if (fe && !has(k, SP_ROLE.mobile.keys)) add("frontend");
  else if (be) add("backend");
  for (const role of SP_ROLES) {
    if (["frontend", "backend", "fullstack", "genai", "aiml", "data-science", "mobile", "sde"].includes(role.key)) continue;
    const byKey = role.keys.length > 0 && has(k, role.keys);
    const byPath = role.paths?.some((re) => paths.some((p) => re.test(p))) ?? false;
    const byDep = role.deps?.some((re) => deps.some((d) => re.test(d))) ?? false;
    if (byKey || byPath || byDep) add(role.key);
  }
  return out;
}

// ── Course / tutorial / clone projects ───────────────────────────────────────

/** NxtWave course apps and the internet's most common tutorial builds. */
const COURSE_TITLES = [
  /nxt\s*trendz/i, /nxt\s*watch/i, /jobby\s*app/i, /tasty\s*kitchens/i, /food\s*munch/i, /wikipedia\s*search/i,
  /\btodos?\s*(app|application)?\b/i, /emoji\s*game/i, /match\s*game/i, /memory\s*matrix/i, /ipl\s*dashboard/i,
  /covid[\s-]*19?\s*dashboard/i, /book\s*hub/i, /money\s*manager/i, /password\s*manager/i, /appointments?\s*app/i,
  /cryptocurrency\s*tracker/i, /blog\s*list/i, /coin\s*toss/i, /rock\s*paper\s*scissors/i, /speedometer/i,
  /capitals?\s*app/i, /gradient\s*generator/i, /destinations?\s*search/i, /tourism\s*website/i,
  /build\s*your\s*own\s*(static|responsive|dynamic)/i, /static\s*website/i,
];
const TOY_TITLES = [
  /\bcalculator\b/i, /\bweather\s*(app|forecast)?\b/i, /tic[\s-]*tac[\s-]*toe/i, /\bportfolio\b/i, /landing\s*page/i,
  /\bbmi\b/i, /stop\s*watch|stopwatch/i, /digital\s*clock/i, /\bcounter\s*app\b/i, /currency\s*converter/i,
  /\b(netflix|amazon|flipkart|spotify|instagram|youtube|whatsapp|twitter|zomato|swiggy|uber|airbnb)\s*clone\b/i,
  /\bclone\b/i,
];

/** "course" (NxtWave course app / ccbp.tech demo), "toy" (common tutorial build) or "". */
export function courseKind(title: string, urls: string[] = []): "course" | "toy" | "" {
  if (urls.some((u) => /ccbp\.tech|nxtwave\.(?:tech|in)/i.test(u))) return "course";
  if (COURSE_TITLES.some((re) => re.test(title))) return "course";
  if (TOY_TITLES.some((re) => re.test(title))) return "toy";
  return "";
}

/** A title's meaningful words: letters / digits only, common words dropped. */
export function titleWords(title: string): string[] {
  return (title ?? "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^(app|application|website|web|project|system|platform|using|based|the|and|for|with)$/.test(w));
}

/** A comparable title ("Nxt Trendz – E-commerce App" ≈ "NxtTrendz"). */
export function titleKey(title: string): string {
  return titleWords(title).join("").slice(0, 40);
}

/**
 * The key for spotting the same project on many resumes of one batch (a course / template build) —
 * "" for generic one-word titles ("E-commerce Website", "Chat App"), which different people share
 * without copying anything.
 */
export function batchTitleKey(title: string): string {
  const w = titleWords(title);
  return w.length >= 2 ? w.join("").slice(0, 40) : "";
}
