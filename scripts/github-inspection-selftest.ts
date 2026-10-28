/**
 * Domain Shortlisting — GitHub inspection self-test. Offline: GitHub is a mock (fetch is
 * replaced), so this runs anywhere, costs no quota and is deterministic.
 *
 * Covers the added languages and infrastructure (Go, Rust, C/C++, Swift / iOS, PHP, Laravel,
 * Ruby, Rails, Redis, Kafka, GraphQL, Terraform) — their manifests, imports and false-positive
 * guards — the everyday-word rules ("Go", "Swift", "C"), the mandatory guard, the evidence /
 * mandatory-gap / claimed-not-found outputs, own commits in someone else's repo, very large
 * repos, and the 24 h inspection cache (reuse, refresh, never caching failures, coalescing).
 *
 *   npx tsx scripts/github-inspection-selftest.ts
 */
import "./server-only-shim";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cacheDir = mkdtempSync(join(tmpdir(), "gh-inspect-test-"));
process.env.GITHUB_TOKEN = "ghp_test_token_for_selftest";
process.env.GITHUB_CACHE_DIR = cacheDir;
process.env.GITHUB_CACHE_TTL_HOURS = "24";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── Mock GitHub ──────────────────────────────────────────────────────────────

interface MockRepo {
  owner: string;
  name: string;
  language?: string;
  size?: number;
  fork?: boolean;
  description?: string;
  files: Record<string, string>;
  /** Commits by login ("" = unlinked email). */
  commits?: { login: string; daysAgo: number }[];
}
interface MockUser {
  login: string;
  repos: MockRepo[];
}

const users = new Map<string, MockUser>();
const extraRepos = new Map<string, MockRepo>();
const calls: string[] = [];
let throttle = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4000" } });

function repoMeta(r: MockRepo) {
  const size = r.size ?? Math.max(1, Math.round(Object.values(r.files).reduce((s, f) => s + f.length, 0) / 1024));
  return {
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    html_url: `https://github.com/${r.owner}/${r.name}`,
    description: r.description ?? "",
    language: r.language ?? null,
    topics: [],
    fork: Boolean(r.fork),
    archived: false,
    size,
    stargazers_count: 0,
    created_at: "2025-01-01T00:00:00Z",
    pushed_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    owner: { login: r.owner },
  };
}

function findRepo(owner: string, name: string): MockRepo | undefined {
  const u = users.get(owner.toLowerCase());
  return u?.repos.find((r) => r.name === name) ?? extraRepos.get(`${owner}/${name}`.toLowerCase());
}

function commitItems(r: MockRepo, author: string | null) {
  const list = (r.commits ?? [{ login: r.owner, daysAgo: 10 }]).filter((c) => !author || c.login.toLowerCase() === author.toLowerCase());
  return list.map((c, i) => {
    const date = new Date(Date.now() - c.daysAgo * 86_400_000).toISOString();
    return {
      sha: `${r.name}${i}`.padEnd(40, "0"),
      commit: { message: `change ${i}`, author: { name: c.login || "someone", email: `${c.login || "x"}@example.com`, date }, committer: { date } },
      author: c.login ? { login: c.login, type: "User" } : null,
      committer: c.login ? { login: c.login } : null,
      parents: [{ sha: "p" }],
    };
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  calls.push(url);
  if (throttle && url.includes("api.github.com")) return json({ message: "rate limited" }, 429);
  const u = new URL(url);
  if (u.hostname === "raw.githubusercontent.com") {
    const [owner, repo, , ...path] = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const file = findRepo(owner, repo)?.files[path.join("/")];
    return file === undefined ? new Response("", { status: 404 }) : new Response(file, { status: 200 });
  }
  if (u.hostname !== "api.github.com") return new Response("", { status: 404 });
  if (u.pathname === "/graphql") {
    void init;
    return json({ data: { user: { contributionsCollection: { totalCommitContributions: 40, restrictedContributionsCount: 2 } } } });
  }
  let m = u.pathname.match(/^\/users\/([^/]+)\/repos$/);
  if (m) {
    const user = users.get(decodeURIComponent(m[1]).toLowerCase());
    if (!user) return json({ message: "Not Found" }, 404);
    return json(u.searchParams.get("page") === "1" ? user.repos.map(repoMeta) : []);
  }
  m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/HEAD$/);
  if (m) {
    const r = findRepo(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if (!r) return json({ message: "Not Found" }, 404);
    const recursive = u.searchParams.get("recursive") === "1";
    const paths = Object.keys(r.files).filter((p) => recursive || !p.includes("/"));
    const dirs = recursive ? [] : [...new Set(Object.keys(r.files).filter((p) => p.includes("/")).map((p) => p.split("/")[0]))];
    return json({
      tree: [...paths.map((p) => ({ path: p, type: "blob", size: r.files[p].length })), ...dirs.map((d) => ({ path: d, type: "tree" }))],
      truncated: false,
    });
  }
  m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/commits$/);
  if (m) {
    const r = findRepo(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    return r ? json(commitItems(r, u.searchParams.get("author"))) : json({ message: "Not Found" }, 404);
  }
  m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (m) {
    const r = findRepo(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    return r ? json(repoMeta(r)) : json({ message: "Not Found" }, 404);
  }
  return json({ message: "Not Found" }, 404);
}) as typeof fetch;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GO_MAIN = `package main

import (
\t"fmt"
\t"net/http"

\t"github.com/gin-gonic/gin"
\tredis "github.com/redis/go-redis/v9"
\t"github.com/segmentio/kafka-go"
)

func main() {
\trdb := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
\tw := kafka.NewWriter(kafka.WriterConfig{Brokers: []string{"localhost:9092"}, Topic: "orders"})
\tr := gin.Default()
\tr.GET("/health", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
\tfmt.Println(rdb, w)
\tr.Run()
}
`;

users.set("gopher", {
  login: "gopher",
  repos: [
    {
      owner: "gopher",
      name: "order-service",
      language: "Go",
      files: {
        "go.mod": `module github.com/gopher/order-service

go 1.22

require (
\tgithub.com/gin-gonic/gin v1.9.1
\tgithub.com/redis/go-redis/v9 v9.5.1
\tgithub.com/segmentio/kafka-go v0.4.47
\tgolang.org/x/net v0.24.0 // indirect
)
`,
        "main.go": GO_MAIN,
        "internal/store/store.go": `package store\n\nimport "context"\n\nfunc (s *Store) Save(ctx context.Context) error { return nil }\n` + "// padding ".repeat(20),
        "docker-compose.yml": "services:\n  cache:\n    image: redis:7\n  broker:\n    image: bitnami/kafka:3.7\n",
        "README.md": "# Order service\nA Go service with GraphQL planned.",
      },
    },
  ],
});

users.set("rustacean", {
  login: "rustacean",
  repos: [
    {
      owner: "rustacean",
      name: "cache-cli",
      language: "Rust",
      files: {
        "Cargo.toml": `[package]\nname = "cache-cli"\nversion = "0.1.0"\n\n[dependencies]\ntokio = { version = "1", features = ["full"] }\nredis = "0.25"\n\n[dependencies.serde]\nversion = "1"\n\n[dev-dependencies]\ncriterion = "0.5"\n`,
        "src/main.rs": `use redis::Commands;\nuse std::env;\n\nfn main() {\n    let mut con = redis::Client::open("redis://127.0.0.1/").unwrap().get_connection().unwrap();\n    let _: () = con.set("k", 1).unwrap();\n}\n`,
      },
    },
  ],
});

users.set("artisan", {
  login: "artisan",
  repos: [
    {
      owner: "artisan",
      name: "shop",
      language: "PHP",
      files: {
        "composer.json": JSON.stringify({ require: { php: "^8.2", "ext-json": "*", "laravel/framework": "^11.0", "predis/predis": "^2.2" }, "require-dev": { "phpunit/phpunit": "^11" } }),
        artisan: "#!/usr/bin/env php\n<?php\n// Laravel artisan\n" + "x".repeat(60),
        "routes/web.php": "<?php\n\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/', function () { return view('welcome'); });\n",
        "app/Http/Controllers/OrderController.php":
          "<?php\n\nnamespace App\\Http\\Controllers;\n\nuse Illuminate\\Http\\Request;\nuse Predis\\Client;\n\nclass OrderController extends Controller\n{\n    public function index(Request $r) { return []; }\n}\n",
      },
    },
  ],
});

users.set("railsdev", {
  login: "railsdev",
  repos: [
    {
      owner: "railsdev",
      name: "blog",
      language: "Ruby",
      files: {
        Gemfile: `source "https://rubygems.org"\ngem "rails", "~> 7.1"\ngem 'redis'\ngem "sidekiq"\n`,
        "config/routes.rb": "Rails.application.routes.draw do\n  resources :posts\nend\n" + "# routes ".repeat(10),
        "app/controllers/posts_controller.rb":
          "class PostsController < ApplicationController\n  def index\n    @posts = Post.all\n  end\nend\n" + "# padding ".repeat(10),
        "db/migrate/20240101000000_create_posts.rb": "class CreatePosts < ActiveRecord::Migration[7.1]\nend\n",
      },
    },
  ],
});

users.set("iosdev", {
  login: "iosdev",
  repos: [
    {
      owner: "iosdev",
      name: "weather",
      language: "Swift",
      files: {
        "Weather.xcodeproj/project.pbxproj": "// !$*UTF8*$!\n{ archiveVersion = 1; }",
        "Weather/ContentView.swift":
          "import SwiftUI\n\nstruct ContentView: View {\n    var body: some View {\n        Text(\"Hello\")\n    }\n}\n" + "// padding ".repeat(5),
        Podfile: "platform :ios, '16.0'\ntarget 'Weather' do\n  pod 'Alamofire', '~> 5.8'\n  pod 'Firebase/Analytics'\nend\n",
      },
    },
  ],
});

users.set("flutterdev", {
  login: "flutterdev",
  repos: [
    {
      owner: "flutterdev",
      name: "todo-app",
      language: "Dart",
      files: {
        "pubspec.yaml": "name: todo_app\ndependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.2.0\n",
        "lib/main.dart": "import 'package:flutter/material.dart';\n\nvoid main() => runApp(const MyApp());\n" + "// padding ".repeat(10),
        "ios/Runner/AppDelegate.swift":
          "import Flutter\nimport UIKit\n\n@main\n@objc class AppDelegate: FlutterAppDelegate {\n  override func application() -> Bool { return true }\n}\n",
        "ios/Runner.xcodeproj/project.pbxproj": "// generated",
        "ios/Podfile": "platform :ios, '12.0'\nflutter_ios_podfile_setup\n",
        "linux/main.cc": '#include "my_application.h"\n\nint main(int argc, char** argv) {\n  return 0;\n}\n' + "// padding ".repeat(5),
        "linux/CMakeLists.txt": "cmake_minimum_required(VERSION 3.10)\nproject(runner LANGUAGES CXX)\n",
        "windows/runner/main.cpp": "#include <windows.h>\n#include <vector>\nint main() { std::vector<int> v; return 0; }\n" + "// padding ".repeat(5),
      },
    },
  ],
});

// A Flutter app in a sub-folder and a Flutter plugin's example app: still template shells.
users.set("nestedflutter", {
  login: "nestedflutter",
  repos: [
    {
      owner: "nestedflutter",
      name: "zhaoxi",
      language: "Dart",
      files: {
        "app/pubspec.yaml": `name: zhaoxi
dependencies:
  flutter:
    sdk: flutter
`,
        "app/lib/app.dart": `import 'package:flutter/material.dart';
` + "// padding ".repeat(10),
        "app/macos/Runner.xcodeproj/project.pbxproj": "// generated",
        "app/macos/Runner/MainFlutterWindow.swift": `import Cocoa
import FlutterMacOS
class MainFlutterWindow: NSWindow {}
` + "// padding ".repeat(5),
        "example/pubspec.yaml": `name: example
`,
        "example/ios/Runner/AppDelegate.swift": `import Flutter
import UIKit
@main
@objc class AppDelegate: FlutterAppDelegate {}
` + "// padding ".repeat(5),
        "app/windows/runner/main.cpp": `#include <windows.h>
int main() { std::vector<int> v; return 0; }
` + "// padding ".repeat(5),
        "app/linux/CMakeLists.txt": "project(runner LANGUAGES CXX)",
      },
    },
  ],
});

// A native monorepo (no package.json / pubspec): its top-level ios/ IS the candidate's Swift.
users.set("nativemono", {
  login: "nativemono",
  repos: [
    {
      owner: "nativemono",
      name: "mobile",
      language: "Swift",
      files: {
        "ios/Mobile.xcodeproj/project.pbxproj": "// project",
        "ios/Mobile/HomeView.swift": `import SwiftUI

struct HomeView: View {
    var body: some View { Text("Home") }
}
` + "// padding ".repeat(5),
        "android/app/src/main/java/com/x/MainActivity.kt": `package com.x
class MainActivity : ComponentActivity() {}
` + "// padding ".repeat(5),
      },
    },
  ],
});

// LeetCode-style C++: a class Solution, no main, no includes.
users.set("leetcpp", {
  login: "leetcpp",
  repos: [
    {
      owner: "leetcpp",
      name: "leetcode",
      language: "C++",
      files: {
        "0001-two-sum/0001-two-sum.cpp": `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> seen;
        return {};
    }
};
`,
        "0001-two-sum/README.md": "Two Sum",
      },
    },
  ],
});

users.set("cpper", {
  login: "cpper",
  repos: [
    {
      owner: "cpper",
      name: "dsa-solutions",
      language: "C++",
      files: {
        "arrays/two_sum.cpp": "#include <bits/stdc++.h>\nusing namespace std;\nint main() { vector<int> a; cout << a.size(); return 0; }\n" + "// padding ".repeat(5),
        "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(dsa)\n",
      },
    },
  ],
});

users.set("infra", {
  login: "infra",
  repos: [
    {
      owner: "infra",
      name: "aws-stack",
      language: "HCL",
      files: {
        "main.tf": 'terraform {\n  required_version = ">= 1.6"\n}\n\nprovider "aws" {\n  region = "ap-south-1"\n}\n\nresource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n',
        ".terraform.lock.hcl": "# lock",
      },
    },
  ],
});

users.set("gqldev", {
  login: "gqldev",
  repos: [
    {
      owner: "gqldev",
      name: "books-api",
      language: "JavaScript",
      files: {
        "package.json": JSON.stringify({ dependencies: { "@apollo/server": "^4.10.0", graphql: "^16.8.0", express: "^4.19.0" } }),
        "src/index.js": "import { ApolloServer } from '@apollo/server';\nimport express from 'express';\nconst server = new ApolloServer({ typeDefs, resolvers });\n",
        "schema.graphql": "type Query {\n  books: [Book]\n}\n",
      },
    },
  ],
});

// A candidate whose real work is in a team repo they don't own: 120 teammate commits, theirs older.
users.set("teamplayer", {
  login: "teamplayer",
  repos: [{ owner: "teamplayer", name: "notes", language: "JavaScript", files: { "README.md": "# notes\nPersonal notes." } }],
});
extraRepos.set("acme-org/payments", {
  owner: "acme-org",
  name: "payments",
  language: "Go",
  files: { "go.mod": "module github.com/acme-org/payments\n\nrequire github.com/redis/go-redis/v9 v9.5.1\n", "main.go": GO_MAIN },
  commits: [...Array.from({ length: 120 }, (_, i) => ({ login: "teammate", daysAgo: i + 1 })), { login: "teamplayer", daysAgo: 200 }],
});

// A very large ML repo (committed weights) — only its top level can be listed.
users.set("bigml", {
  login: "bigml",
  repos: [
    {
      owner: "bigml",
      name: "vision-model",
      language: "Python",
      size: 350_000,
      files: {
        "requirements.txt": "torch==2.3.0\ntorchvision==0.18.0\nfastapi==0.111.0\n",
        "README.md": "# Vision model\nTrained with PyTorch.",
        "weights/model.pt": "binary",
      },
    },
  ],
});

// A Python ML repo with some C++ next to it: what the original analyzer reads must not change.
users.set("mixed", {
  login: "mixed",
  repos: [
    {
      owner: "mixed",
      name: "fast-ml",
      language: "Python",
      files: {
        "requirements.txt": "torch==2.3.0\nfastapi==0.111.0\nscikit-learn==1.5.0\n",
        "train.py": "import torch\nfrom torch import nn\n\nclass Net(nn.Module):\n    pass\n" + "# padding ".repeat(20),
        "app.py": "from fastapi import FastAPI\napp = FastAPI()\n\n@app.get('/predict')\ndef predict():\n    return {}\n" + "# padding ".repeat(20),
        "csrc/kernel.cpp": "#include <vector>\n#include <torch/extension.h>\nstd::vector<int> f() { return {}; }\n" + "// padding ".repeat(10),
        "csrc/main.cpp": "#include <iostream>\nint main() { std::cout << 1; }\n" + "// padding ".repeat(10),
        "README.md": "# fast-ml\nPyTorch + FastAPI service.",
      },
    },
  ],
});

// ── Tests ────────────────────────────────────────────────────────────────────

(async () => {
  const ga = await import("@/lib/github-analysis");
  const { inspectDomainGithub } = await import("@/lib/domain-screen");
  const { resetInspectionCacheMemory } = await import("@/lib/github-inspect-cache");
  const spec = (mandatory: string, domain = "") => ga.buildJdTechSpec(mandatory, domain, { modelledOnly: true });

  console.log("JD wording → technologies");
  ok("Go, Redis, Kafka mandatory", same(spec("Go, Redis, Kafka").mandatory, ["Go", "Redis", "Kafka"]), spec("Go, Redis, Kafka"));
  ok("Java/Kotlin/Go/Python lists Go", spec("Java/Kotlin/Go/Python").mandatory.includes("Go"));
  ok("lower-case list item 'go'", spec("java, go, python").mandatory.includes("Go"));
  ok("Go (Golang)", spec("Go (Golang)").mandatory.includes("Go"));
  ok("'services in Go' mid-sentence", spec("", "Build backend services in Go or Java").goodToHave.includes("Go"));
  ok("go-to-market is not Go", !spec("", "Own the go-to-market plan").goodToHave.includes("Go"));
  ok("'Go beyond' at sentence start is not Go", !spec("", "Go beyond the basics. Ship fast.").goodToHave.includes("Go"));
  ok("let's go is not Go", !spec("", "we are hiring, let's go").goodToHave.includes("Go"));
  ok("Swift mid-sentence", spec("", "Native apps written in Swift and SwiftUI").goodToHave.includes("Swift / iOS"));
  ok("swift delivery is not Swift", !spec("", "Ensure swift delivery of features").goodToHave.includes("Swift / iOS"));
  ok("Flutter for Android and iOS is not native iOS", !spec("Flutter apps for Android and iOS").mandatory.includes("Swift / iOS"));
  ok("C, C++ → C/C++", spec("C, C++, Python").mandatory.includes("C/C++"));
  ok("Languages: C → C/C++", spec("Languages: C").mandatory.includes("C/C++"));
  ok("C-suite is not C", !spec("", "Present to C-suite stakeholders").goodToHave.includes("C/C++"));
  ok("CI/CD is not C", !spec("CI/CD").mandatory.includes("C/C++"));
  ok("C# is .NET, not C/C++", !spec("C#").mandatory.includes("C/C++") && spec("C#").mandatory.includes("C# / .NET"));
  ok("Ruby on Rails → Rails only", same(spec("Ruby on Rails").mandatory, ["Ruby on Rails"]), spec("Ruby on Rails"));
  ok("Ruby and Ruby on Rails → both", same(spec("Ruby and Ruby on Rails").mandatory, ["Ruby", "Ruby on Rails"]));
  ok("LLM guard-rails is not Rails", !spec("", "LLM guard-rails and evals").goodToHave.includes("Ruby on Rails"));
  ok("HCL (the company) is not Terraform", !spec("", "No IT services: TCS, HCL, Wipro").goodToHave.includes("Terraform"));
  ok("Apollo Hospitals is not GraphQL", !spec("", "Apollo Hospitals patient data").goodToHave.includes("GraphQL"));
  ok("Laravel, PHP", same(spec("Laravel, PHP").mandatory, ["PHP", "Laravel"]), spec("Laravel, PHP"));
  ok("Terraform", spec("Terraform on AWS").mandatory.includes("Terraform"));
  ok("GraphQL", spec("GraphQL APIs").mandatory.includes("GraphQL"));

  // Briefs that name only the original technologies resolve exactly as before the added
  // languages (golden values recorded from the previous analyzer).
  const briefs: [string, string, { mandatory: string[]; goodToHave: string[] }][] = [
    [
      "React.js, Node.js, MongoDB",
      "MERN full stack — React, Node.js with Express, MongoDB, REST APIs, JWT auth, Docker",
      { mandatory: ["React", "Node.js / Express", "MongoDB"], goodToHave: ["Docker", "REST APIs"] },
    ],
    [
      "Python, PyTorch",
      "Generative AI — LLMs, RAG with LangChain, vector databases, FastAPI, Hugging Face Transformers, evals",
      { mandatory: ["Python", "PyTorch"], goodToHave: ["Transformers", "FastAPI/Flask", "LLMs", "Hugging Face"] },
    ],
    [
      "Selenium or Playwright, Java",
      "QA automation — Selenium WebDriver, TestNG, REST Assured, Postman, CI/CD with Jenkins",
      { mandatory: ["Java", "Selenium", "Playwright"], goodToHave: ["CI/CD", "Automated testing", "API testing (Postman / REST Assured)"] },
    ],
    [
      "Kotlin, Jetpack Compose",
      "Android development — MVVM, Room, Retrofit, Hilt, coroutines, Play Store release",
      { mandatory: ["Android / Kotlin"], goodToHave: ["Android architecture (Jetpack, MVVM, DI)", "App store release (Play Store / App Store)"] },
    ],
    [
      "",
      "Data analytics — SQL, Power BI, Excel, pandas, data visualisation, dashboards",
      { mandatory: [], goodToHave: ["SQL", "Power BI", "Pandas / data wrangling", "Data visualisation", "Excel"] },
    ],
  ];
  for (const [m, d, want] of briefs) {
    const { mandatory, goodToHave } = spec(m, d);
    const got = { mandatory, goodToHave };
    ok(`original-tech brief unchanged: ${d.slice(0, 30)}`, same(got, want), { got, want });
  }

  console.log("Mandatory guard (resume names the tech?)");
  const resume = "Skills: Java, Golang, Docker\nProjects: Weather app in SwiftUI. Order service using Kafka and Redis caching.";
  ok("Golang counts for Go", !ga.mandatoryTechsAbsent("Go", resume).includes("Go"));
  ok("SwiftUI counts for Swift", !ga.mandatoryTechsAbsent("Swift", resume).includes("Swift / iOS"));
  ok("Kafka named", ga.mandatoryTechsAbsent("Kafka, Redis", resume).length === 0);
  ok("GraphQL absent", same(ga.mandatoryTechsAbsent("GraphQL", resume), ["GraphQL"]));
  ok("'go-to person' is not Go", same(ga.mandatoryTechsAbsent("Go", "I am the go-to person for Java"), ["Go"]));
  ok("Go as a list item", ga.mandatoryTechsAbsent("Go", "Languages: Python, Go, SQL").length === 0);
  // The guard's answers for the original technologies (golden, from the previous analyzer).
  const guardCases: [string, string, string[]][] = [
    ["Node.js with Express backend, MongoDB", "Built REST APIs with ExpressJS and Mongo DB; React frontend", []],
    ["React, Node.js", "Python developer, Django, PostgreSQL", ["React", "Node.js / Express"]],
    ["LLM, RAG", "Built a chatbot with the OpenAI API and Pinecone; storage optimisation", []],
    ["Selenium", "Manual testing, JIRA", ["Selenium"]],
    ["SQL, Power BI", "Excel dashboards, MySQL queries", ["Power BI"]],
  ];
  for (const [m, r, want] of guardCases) {
    const got = ga.mandatoryTechsAbsent(m, r);
    ok(`guard unchanged: ${m}`, same(got, want), { got, want });
  }
  ok("claims: Go, Kafka, Redis named; GraphQL not", same(ga.techsNamedIn(["Go", "Redis", "Kafka", "GraphQL"], resume), ["Go", "Redis", "Kafka"]));
  ok("bucketing claim reader: Go via Golang, not 'go-to'", ga.techKeysInText("Golang, Redis").includes("go") && !ga.techKeysInText("the go-to guy").includes("go"));

  const inspect = async (user: string, mandatory: string, domain = "", extra: string[] = []) => {
    const r = await ga.analyzeGithubProfile(`https://github.com/${user}`, extra, spec(mandatory, domain));
    if (!r.ok) throw new Error(`${user}: ${r.message}`);
    return r.analysis;
  };

  console.log("Added languages, read from real files");
  const go = await inspect("gopher", "Go, Redis, Kafka, GraphQL");
  ok("Go / Redis / Kafka proven", ["Go", "Redis", "Kafka"].every((t) => go.provenTechs.includes(t)), go.provenTechs);
  ok("go.mod read (Redis from go.mod or code)", go.techEvidence.some((e) => e.tech === "Redis"), go.techEvidence);
  ok("indirect go.mod deps ignored", !JSON.stringify(go).includes("golang.org/x/net declared"));
  const gqlGap = go.mandatoryGaps.find((g) => g.tech === "GraphQL");
  ok("GraphQL: README-only mandatory gap", gqlGap?.reason === "readme-only", go.mandatoryGaps);
  ok("evidence names the repo", go.techEvidence.every((e) => e.repo === "order-service" && e.detail.length > 0), go.techEvidence);

  const rust = await inspect("rustacean", "Rust, Redis");
  ok("Rust + Redis proven (Cargo.toml / use redis)", rust.provenTechs.includes("Rust") && rust.provenTechs.includes("Redis"), rust.provenTechs);

  const php = await inspect("artisan", "Laravel, PHP, Redis");
  ok("Laravel + PHP + Redis (composer / artisan / use Illuminate / predis)", ["Laravel", "PHP", "Redis"].every((t) => php.provenTechs.includes(t)), php.provenTechs);

  const rails = await inspect("railsdev", "Ruby on Rails, Redis");
  ok("Rails + Redis (Gemfile / routes.rb / controller)", ["Ruby on Rails", "Redis"].every((t) => rails.provenTechs.includes(t)), rails.provenTechs);

  const ios = await inspect("iosdev", "Swift");
  ok("Swift / iOS proven (xcodeproj, SwiftUI)", ios.provenTechs.includes("Swift / iOS"), ios.provenTechs);

  const flutter = await inspect("flutterdev", "Swift, C++", "Flutter mobile apps");
  ok("Flutter shells prove neither Swift / iOS nor C/C++", !flutter.provenTechs.includes("Swift / iOS") && !flutter.provenTechs.includes("C/C++"), {
    proven: flutter.provenTechs,
    gaps: flutter.mandatoryGaps,
  });

  const nested = await inspect("nestedflutter", "Swift, C++", "Flutter mobile apps");
  ok("nested Flutter app / plugin example: no Swift / iOS, no C/C++", !nested.provenTechs.includes("Swift / iOS") && !nested.provenTechs.includes("C/C++"), nested.provenTechs);
  const mono = await inspect("nativemono", "Swift");
  ok("native monorepo ios/ (no app manifest) counts as Swift / iOS", mono.provenTechs.includes("Swift / iOS"), mono.provenTechs);
  const leet = await inspect("leetcpp", "C++");
  ok("LeetCode-style C++ proven by code", leet.provenTechs.includes("C/C++") && leet.techEvidence.some((e) => e.tech === "C/C++" && e.source === "code"), leet.techEvidence);

  const cpp = await inspect("cpper", "C++");
  ok("C/C++ proven (bits/stdc++, CMakeLists)", cpp.provenTechs.includes("C/C++"), cpp.provenTechs);

  const tf = await inspect("infra", "Terraform");
  ok("Terraform proven (main.tf)", tf.provenTechs.includes("Terraform"), tf.provenTechs);

  const gql = await inspect("gqldev", "GraphQL, Node.js");
  ok("GraphQL proven (@apollo/server, new ApolloServer, schema.graphql)", gql.provenTechs.includes("GraphQL"), gql.provenTechs);

  console.log("Someone else's repo, very large repos");
  calls.length = 0;
  const team = await inspect("teamplayer", "Go, Redis", "", ["https://github.com/acme-org/payments"]);
  const teamCommitCall = calls.find((c) => c.includes("/repos/acme-org/payments/commits"));
  ok("team repo asks for the candidate's own commits", Boolean(teamCommitCall?.includes("author=teamplayer")), teamCommitCall);
  ok("team repo credited (old commit found)", team.provenTechs.includes("Redis") && team.matchingCount >= 1, { proven: team.provenTechs, matches: team.matchingCount });
  const ownCommitCall = calls.find((c) => c.includes("/repos/teamplayer/notes/commits"));
  ok("own repo still reads the latest 100", Boolean(ownCommitCall) && !ownCommitCall!.includes("author="), ownCommitCall);

  calls.length = 0;
  const big = await inspect("bigml", "PyTorch", "Computer vision with PyTorch and FastAPI");
  const treeCall = calls.find((c) => c.includes("/repos/bigml/vision-model/git/trees/HEAD"));
  ok("very large repo: top-level tree (no recursive)", Boolean(treeCall) && !treeCall!.includes("recursive"), treeCall);
  ok("very large repo: PyTorch proven from root requirements", big.provenTechs.includes("PyTorch"), big.provenTechs);
  ok("very large repo: says only the top level was read", big.topRepos[0]?.evidence.some((e) => /top-level/.test(e.detail)), big.topRepos[0]?.evidence);

  console.log("Original languages: same files read, same scores");
  const mixedSpec = spec("PyTorch", "ML inference — PyTorch models served with FastAPI, scikit-learn");
  const rawReads = async (fn: () => Promise<unknown>) => {
    calls.length = 0;
    const out = await fn();
    return { out, raw: calls.filter((c) => c.includes("raw.githubusercontent.com")).map((c) => c.split("/HEAD/")[1]) };
  };
  // The same Python repo with and without C++ next to it: the Python files read, in order, and
  // the score for a Python domain must not change — the C++ is only read in the extra slots.
  const mixed = users.get("mixed")!.repos[0];
  users.set("pureml", {
    login: "pureml",
    repos: [{ ...mixed, owner: "pureml", files: Object.fromEntries(Object.entries(mixed.files).filter(([f]) => !f.startsWith("csrc/"))) }],
  });
  const pure = await rawReads(() => ga.analyzeGithubProfile("https://github.com/pureml", [], mixedSpec));
  const withCpp = await rawReads(() => ga.analyzeGithubProfile("https://github.com/mixed", [], mixedSpec));
  ok("Python files read first, in the same order", same(withCpp.raw.slice(0, pure.raw.length), pure.raw), { pure: pure.raw, withCpp: withCpp.raw });
  ok("the C++ is read only after them", withCpp.raw.slice(pure.raw.length).every((f) => /\.(?:cpp|cc|c|h|hpp)$/.test(f)) && withCpp.raw.length > pure.raw.length, withCpp.raw);
  const scoreOf = (r: unknown) => {
    const a = (r as { ok: boolean; analysis: { overallMatchPct: number; matchingCount: number; topRepos: { matchPct: number }[] } }).analysis;
    return { pct: a.overallMatchPct, matches: a.matchingCount, repos: a.topRepos.map((t) => t.matchPct) };
  };
  ok("Python-domain score unchanged by the C++", same(scoreOf(pure.out), scoreOf(withCpp.out)), { pure: scoreOf(pure.out), withCpp: scoreOf(withCpp.out) });

  console.log("Domain inspection: evidence, gaps, claims, 24 h cache");
  resetInspectionCacheMemory();
  const input = { id: "c1", githubProfile: "https://github.com/gopher", githubRepos: [], claimedTechs: ["Go", "Kafka", "GraphQL", "Redis"] };
  calls.length = 0;
  const first = await inspectDomainGithub(input, "Backend — Go microservices with Redis, Kafka and GraphQL", "Go, Kafka");
  const firstCalls = calls.length;
  ok("first inspection runs", first.status === "checked" && !first.fromCache && firstCalls > 0, { status: first.status, calls: firstCalls });
  ok("evidence lines", first.evidence.length >= 3 && first.evidence.every((e) => e.detail), first.evidence);
  ok("claimed but not found = GraphQL", same(first.claimedNotFound, ["GraphQL"]), first.claimedNotFound);
  ok("no mandatory gaps (Go, Kafka proven)", first.mandatoryGaps.length === 0, first.mandatoryGaps);
  ok("checkedAt stamped", !Number.isNaN(Date.parse(first.checkedAt)));
  ok("cache file written", readdirSync(cacheDir).some((f) => f.endsWith(".json")));

  calls.length = 0;
  const second = await inspectDomainGithub({ ...input, id: "c2", claimedTechs: ["Go"] }, "Backend — Go microservices with Redis, Kafka and GraphQL", "Go, Kafka");
  ok("second inspection reused (no GitHub calls)", second.fromCache && calls.length === 0, { fromCache: second.fromCache, calls: calls.length });
  ok("reused result carries this request's id and claims", second.id === "c2" && second.claimedNotFound.length === 0 && second.score === first.score);
  ok("reused result keeps the original checkedAt", second.checkedAt === first.checkedAt);

  resetInspectionCacheMemory();
  calls.length = 0;
  const fromDisk = await inspectDomainGithub(input, "Backend — Go microservices with Redis, Kafka and GraphQL", "Go, Kafka");
  ok("survives a restart (read from disk)", fromDisk.fromCache && calls.length === 0);

  calls.length = 0;
  const refreshed = await inspectDomainGithub(input, "Backend — Go microservices with Redis, Kafka and GraphQL", "Go, Kafka", { refresh: true });
  ok("refresh inspects again", !refreshed.fromCache && calls.length > 0);

  calls.length = 0;
  const otherDomain = await inspectDomainGithub(input, "Frontend — React, TypeScript", "React");
  ok("another domain is a different key", !otherDomain.fromCache && calls.length > 0);
  ok("React mandatory gap: no evidence", otherDomain.mandatoryGaps.some((g) => g.tech === "React" && g.reason === "none"), otherDomain.mandatoryGaps);

  // Failures are never cached.
  resetInspectionCacheMemory();
  throttle = true;
  const limited = await inspectDomainGithub({ id: "r1", githubProfile: "https://github.com/rustacean", githubRepos: [] }, "Rust services", "Rust");
  throttle = false;
  ok("rate-limited inspection fails", limited.status === "failed");
  calls.length = 0;
  const afterLimit = await inspectDomainGithub({ id: "r1", githubProfile: "https://github.com/rustacean", githubRepos: [] }, "Rust services", "Rust");
  ok("…and is not reused", afterLimit.status === "checked" && !afterLimit.fromCache && calls.length > 0);

  // A user that doesn't exist is a definite answer — cached.
  const ghost1 = await inspectDomainGithub({ id: "g1", githubProfile: "https://github.com/no-such-user-xyz", githubRepos: [] }, "Rust", "Rust");
  calls.length = 0;
  const ghost2 = await inspectDomainGithub({ id: "g2", githubProfile: "https://github.com/no-such-user-xyz", githubRepos: [] }, "Rust", "Rust");
  ok("missing user: not-found, reused", ghost1.status === "not-found" && ghost2.fromCache && calls.length === 0, { s1: ghost1.status, reused: ghost2.fromCache });

  // A corrupt cache file is a miss, not a crash.
  resetInspectionCacheMemory();
  for (const f of readdirSync(cacheDir).filter((n) => n.endsWith(".json"))) writeFileSync(join(cacheDir, f), "{not json");
  calls.length = 0;
  const afterCorrupt = await inspectDomainGithub(input, "Backend — Go microservices with Redis, Kafka and GraphQL", "Go, Kafka");
  ok("corrupt cache entry → fresh inspection", afterCorrupt.status === "checked" && !afterCorrupt.fromCache && calls.length > 0);

  // Concurrent identical requests share one inspection.
  resetInspectionCacheMemory();
  calls.length = 0;
  const [p1, p2] = await Promise.all([
    inspectDomainGithub({ ...input, id: "x1" }, "Go APIs", "Go", { refresh: true }),
    inspectDomainGithub({ ...input, id: "x2" }, "Go APIs", "Go", { refresh: true }),
  ]);
  const listings = calls.filter((c) => c.includes("/users/gopher/repos")).length;
  ok("two at once → one inspection", listings === 1 && p1.score === p2.score && p1.id === "x1" && p2.id === "x2", { listings });

  rmSync(cacheDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
