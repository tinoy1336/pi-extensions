// The subset matrix runner: does an install of SOME packages load cleanly, with the right
// tools and the right reports about what is missing?
//
// Two roles in one file, because the package under test must resolve pi from the app
// directory it was installed into (the same reason docker/smoke.mjs is copied there):
//
//   (default)    orchestrate: read docker/matrix.json, install each case's tarballs into a
//                clean app dir with scripts/stranger-install.sh, then run this same file
//                inside that app dir as the probe below.
//   --probe      run inside the app dir: load the case's entries through pi's own loader,
//                invoke nothing, and report the raw facts as JSON on stdout. The parent
//                judges them against the five clauses.
//
// PASS, the five clauses, judged per case:
//   1. zero load errors, except the errors a case declares (a known-bad combination);
//   2. every installed package's declared entry appears in the loaded set, and the loaded
//      count matches the case;
//   3. each loaded extension's registered tool set equals its expected set, compared
//      order-insensitively, with no unexpected extension;
//   4. every neighbour a case declares absent produced EXACTLY ONE `neighbour-absent` line
//      naming it, and no absence line names an installed package;
//   5. no `register-failed` line, and no absence line naming something the case did not
//      declare.
//
// A case whose packages are not in this workspace yet is reported as NOT YET PORTED and is
// counted as neither a pass nor a failure, so the matrix grows as packages land. A case
// with expectFailClause is the runner's own control: it MUST fail, on that clause.
//
// A package the case needs from the registry rather than from this workspace is declared in
// `requiresInstall` and installed into the case's app directory as SUPPORT: it resolves for
// the subject's optional import, and clauses 2 and 3 still judge the case's declared
// packages alone.
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MATRIX_PATH = path.join(HERE, "matrix.json");

// ---- shared helpers ---------------------------------------------------------------

function parseArgs(argv) {
	const args = {
		case: null,
		keep: false,
		probe: false,
		tarballs: null,
		workspace: path.resolve(HERE, ".."),
	};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--probe") args.probe = true;
		else if (token === "--keep") args.keep = true;
		else if (token === "--case") args.case = argv[++i];
		else if (token === "--tarballs") args.tarballs = argv[++i];
		else if (token === "--workspace") args.workspace = argv[++i];
		else if (token === "--probe-spec") args.probeSpec = argv[++i];
		else if (token === "--judge") args.judge = argv[++i];
		else if (token === "--report") args.report = argv[++i];
		else throw new Error(`unknown argument: ${token}`);
	}
	return args;
}

/**
 * The environment a case runs in: the caller's, minus every PI_* marker, because those
 * describe the session that INVOKED the matrix, not the case. A worker session's
 * PI_SUBAGENT_CHILD otherwise decides what a case's extensions register.
 */
function withoutPiEnv(extra = {}) {
	const base = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("PI_")),
	);
	return { ...base, ...extra };
}

/** Run a command with a hard bound. A hung step ends the case, never the runner. */
function run(command, argv, options = {}) {
	const result = spawnSync(command, argv, {
		cwd: options.cwd ?? process.cwd(),
		encoding: "utf8",
		env: options.env ?? process.env,
		timeout: options.timeoutMs ?? 300_000,
		killSignal: "SIGKILL",
		maxBuffer: 32 * 1024 * 1024,
		stdio: options.inherit ? "inherit" : "pipe",
	});
	if (result.error) return { ok: false, reason: `spawn failed: ${result.error.message}` };
	if (result.signal)
		return {
			ok: false,
			reason: `killed after ${options.timeoutMs ?? 300_000}ms (${result.signal})`,
		};
	if (result.status !== 0)
		return {
			ok: false,
			reason: `exit ${result.status}: ${(result.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`,
		};
	return { ok: true, stdout: result.stdout ?? "" };
}

/** The workspace's package names and directories, so a case can be judged runnable. */
function workspacePackages(root) {
	const packagesDir = path.join(root, "packages");
	const found = new Map();
	if (!existsSync(packagesDir)) return found;
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifestPath = path.join(packagesDir, entry.name, "package.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		found.set(manifest.name, { dir: path.join(packagesDir, entry.name), manifest });
	}
	return found;
}

/**
 * A registry install spec's package name: `name` or `name@version`, scope-aware ("@scope/a"
 * carries one @ at index 0, which is the scope rather than the version separator).
 */
function registrySpecName(spec) {
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}

/** The packed tarball for a workspace package, matched by the name npm pack produces. */
function tarballFor(tarballDir, name, version) {
	const stem = name.replace(/^@/, "").replace(/\//g, "-");
	const wanted = `${stem}-${version}.tgz`;
	const file = path.join(tarballDir, wanted);
	return existsSync(file) ? file : null;
}

// ---- probe role -------------------------------------------------------------------

async function probeMain(args) {
	const spec = JSON.parse(readFileSync(args.probeSpec, "utf8"));
	const { DefaultResourceLoader, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const home = spec.home;
	const logPath = path.join(home, ".local", "share", "pi-hooks", "log.jsonl");

	const loader = new DefaultResourceLoader({
		cwd: spec.appDir,
		agentDir: spec.agentDir,
		settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: spec.entries,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});

	const report = { loaded: [], errors: [], tools: {}, lines: [] };
	try {
		await loader.reload();
		const { extensions, errors } = loader.getExtensions();
		report.loaded = extensions.map((extension) => extension.path);
		report.errors = errors.map((error) => ({ path: error.path, error: String(error.error) }));
		for (const extension of extensions) {
			report.tools[extension.path] = extension.tools ? [...extension.tools.keys()].sort() : [];
		}
	} catch (error) {
		report.errors.push({
			path: "<loader>",
			error: `reload threw: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
	if (existsSync(logPath)) {
		report.lines = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line))
			.map((line) => ({ source: line.source, kind: line.kind, detail: line.detail ?? {} }));
	}
	console.log(JSON.stringify(report));
}

// ---- orchestration role -----------------------------------------------------------

/** Which package (or fixture) an extension path belongs to, and which entry of it. */
function ownerOf(extensionPath, spec) {
	for (const pkg of spec.installed) {
		const prefix = path.join(spec.appDir, "node_modules", ...pkg.name.split("/")) + path.sep;
		if (extensionPath.startsWith(prefix)) {
			const rel = extensionPath.slice(prefix.length);
			const entry = rel.endsWith("index.ts")
				? path.basename(path.dirname(rel))
				: path.basename(rel, path.extname(rel));
			return { owner: pkg.name, entry };
		}
	}
	for (const fixture of spec.fixtures) {
		if (extensionPath.startsWith(path.join(fixture.dir) + path.sep))
			return { owner: fixture.name, entry: fixture.name };
	}
	return {
		owner: path.basename(path.dirname(extensionPath)),
		entry: path.basename(extensionPath, path.extname(extensionPath)),
	};
}

/**
 * A case's package set names workspace packages: those are the ones the runner resolves and
 * installs from tarballs. A neighbour that lives on the registry is declared in
 * `requiresInstall` instead and installed into the same app directory as support: clauses 2
 * and 3 judge the case's declared packages alone, and clause 4 counts the neighbour
 * installed, so an absence line naming a neighbour the case installed is a failure — the
 * whole point of a with-neighbour case.
 */
function judge(caseSpec, probeReport, spec) {
	const clauses = [];
	const results = [];
	const fail = (clause, detail) => {
		results.push({ clause, ok: false, detail });
		return results;
	};

	// Clause 1 — load errors, unless the case declares which ones it expects.
	const expectedErrors = caseSpec.expectErrors ?? [];
	if (expectedErrors.length === 0) {
		if (probeReport.errors.length === 0)
			results.push({ clause: 1, ok: true, detail: "0 load errors" });
		else
			return fail(
				1,
				`${probeReport.errors.length} load error(s): ${probeReport.errors.map((e) => e.error).join(" | ")}`,
			);
	} else {
		const unmatched = probeReport.errors.filter(
			(error) => !expectedErrors.some((pattern) => error.error.includes(pattern)),
		);
		if (unmatched.length === 0 && probeReport.errors.length > 0) {
			results.push({
				clause: 1,
				ok: true,
				detail: `${probeReport.errors.length} declared error(s)`,
			});
		} else if (unmatched.length > 0) {
			return fail(1, `undeclared load error(s): ${unmatched.map((e) => e.error).join(" | ")}`);
		} else {
			return fail(
				1,
				`expected an error matching ${expectedErrors.join(", ")} and none was reported`,
			);
		}
	}

	// Clause 2 — every installed package's declared entry loaded, and the count matches.
	const missingEntries = [];
	for (const pkg of spec.installed) {
		for (const entry of pkg.entries) {
			const resolved = path.resolve(pkg.dir, entry);
			if (!probeReport.loaded.includes(resolved)) missingEntries.push(`${pkg.name} -> ${entry}`);
		}
	}
	if (missingEntries.length > 0)
		return fail(2, `installed entries not loaded: ${missingEntries.join(", ")}`);
	if (
		caseSpec.expectLoaded !== null &&
		caseSpec.expectLoaded !== undefined &&
		probeReport.loaded.length !== caseSpec.expectLoaded
	) {
		return fail(
			2,
			`loaded ${probeReport.loaded.length} extension(s), expected ${caseSpec.expectLoaded}`,
		);
	}
	results.push({
		clause: 2,
		ok: true,
		detail: `${probeReport.loaded.length} loaded, every installed entry present`,
	});

	// Clause 3 — tool sets equal, order-insensitive, with no unexpected extension.
	const actualByKey = new Map();
	const actualOwners = new Map();
	for (const extensionPath of probeReport.loaded) {
		const { owner, entry } = ownerOf(extensionPath, spec);
		const tools = probeReport.tools[extensionPath] ?? [];
		actualOwners.set(owner, [...(actualOwners.get(owner) ?? []), ...tools]);
		actualByKey.set(`${owner}[${entry}]`, tools);
	}
	const expectedKeys = Object.keys(caseSpec.expectTools ?? {});
	for (const key of expectedKeys) {
		const expected = [...(caseSpec.expectTools[key] ?? [])].sort();
		const actual = (key.includes("[") ? actualByKey.get(key) : actualOwners.get(key)) ?? null;
		const label = key.includes("[")
			? key
			: `${key} (loaded ${actualByKey.has(`${key}[${path.basename(key, path.extname(key))}]`) ? "yes" : "no"})`;
		if (actual === null)
			return fail(3, `${key} registered nothing: no loaded extension belongs to it`);
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			return fail(3, `${key} tools [${actual.join(", ")}] != expected [${expected.join(", ")}]`);
		}
		void label;
	}
	const unexpected = [...actualOwners.keys()].filter(
		(owner) => !expectedKeys.some((key) => key === owner || key.startsWith(`${owner}[`)),
	);
	if (unexpected.length > 0)
		return fail(3, `unexpected loaded extension(s): ${unexpected.join(", ")}`);
	results.push({ clause: 3, ok: true, detail: `${expectedKeys.length} tool set(s) equal` });

	// Clause 4 — exactly one absence line per declared absent neighbour, none for an installed package.
	const absences = probeReport.lines.filter((line) => line.kind === "neighbour-absent");
	const installedNames = new Set(spec.installed.map((pkg) => pkg.name));
	for (const line of absences) {
		const named = line.detail?.neighbour ?? "<unnamed>";
		if (installedNames.has(named))
			return fail(4, `an absence line names installed package ${named}`);
	}
	for (const expected of caseSpec.expectLog ?? []) {
		const matching = absences.filter(
			(line) =>
				(expected.source === undefined || line.source === expected.source) &&
				line.detail?.neighbour === expected.neighbour,
		);
		if (matching.length !== 1) {
			return fail(
				4,
				`expected exactly 1 absence line for ${expected.neighbour} from ${expected.source ?? "any source"}, saw ${matching.length}`,
			);
		}
	}
	results.push({ clause: 4, ok: true, detail: `${absences.length} absence line(s), all declared` });

	// Clause 5 — no registration failure, and no absence line the case did not declare.
	const failed = probeReport.lines.filter((line) => line.kind === "register-failed");
	if (failed.length > 0) return fail(5, `register-failed line(s): ${JSON.stringify(failed)}`);
	const declaredNeighbours = new Set((caseSpec.expectLog ?? []).map((entry) => entry.neighbour));
	const undeclared = absences.filter((line) => !declaredNeighbours.has(line.detail?.neighbour));
	if (undeclared.length > 0) {
		return fail(
			5,
			`absence line(s) for undeclared neighbours: ${undeclared.map((line) => line.detail?.neighbour).join(", ")}`,
		);
	}
	results.push({ clause: 5, ok: true, detail: "no registration failure, no undeclared absence" });
	void clauses;
	return results;
}

/**
 * Every workspace package a case's declared packages depend on, transitively: the SUPPORT
 * set. Staged from the workspace like the subject, because a case must never reach the
 * registry for a package this workspace ships — a dependency resolved from the registry is
 * invisible in the checkout, so the matrix could stay green while the workspace copy was
 * broken.
 */
function workspaceDependencyClosure(seeds, packages) {
	const closure = new Set();
	const queue = [...seeds];
	while (queue.length > 0) {
		const pkg = packages.get(queue.shift());
		if (!pkg) continue;
		const declared = {
			...(pkg.manifest.dependencies ?? {}),
			...(pkg.manifest.peerDependencies ?? {}),
		};
		for (const name of Object.keys(declared)) {
			if (!packages.has(name) || seeds.includes(name) || closure.has(name)) continue;
			closure.add(name);
			queue.push(name);
		}
	}
	return [...closure].sort();
}

function buildCaseDirectory(work, caseSpec, args, packages) {
	const root = path.join(work, "cases", caseSpec.id);
	const appDir = path.join(root, "app");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	const tarballDir = path.join(root, "tarballs");
	const tmp = path.join(root, "tmp");
	for (const dir of [appDir, home, agentDir, tarballDir, tmp]) mkdirSync(dir, { recursive: true });

	// The case's own packages are the SUBJECT: clauses 2 and 3 judge them. Every workspace
	// package they depend on is SUPPORT: staged as a local tarball so npm resolves it from
	// this workspace rather than the registry, and recorded with an EMPTY entry list, which
	// keeps clause 2 vacuous for it, keeps clause 3 failing if it loads unexpectedly, and
	// keeps clause 4 counting it as installed.
	const installed = [];
	const staged = new Set();
	const stage = (name, pkg, support) => {
		const version = pkg.manifest.version;
		const tarball = tarballFor(args.tarballs, name, version);
		if (!tarball) {
			return `no tarball for ${name}@${version} in ${args.tarballs} (run the pack step first)`;
		}
		if (!staged.has(tarball)) {
			staged.add(tarball);
			execFileSync("ln", ["-sf", tarball, path.join(tarballDir, path.basename(tarball))]);
		}
		installed.push({
			name,
			version,
			support,
			dir: path.join(appDir, "node_modules", ...name.split("/")),
			entries: support ? [] : (pkg.manifest.pi?.extensions ?? []),
		});
		return null;
	};

	for (const name of caseSpec.packages ?? []) {
		const pkg = packages.get(name);
		if (!pkg) return { skip: name };
		const failure = stage(name, pkg, false);
		if (failure) return { error: failure };
	}

	const support = [];
	for (const name of workspaceDependencyClosure(caseSpec.packages ?? [], packages)) {
		if (installed.some((entry) => entry.name === name)) continue;
		const pkg = packages.get(name);
		const failure = stage(name, pkg, true);
		if (failure) return { error: failure };
		support.push(`${name}@${pkg.manifest.version}`);
	}

	const installArgs = [
		path.join(args.workspace, "scripts", "stranger-install.sh"),
		appDir,
		tarballDir,
		matrixPiVersion(),
	];
	const installEnv = withoutPiEnv({ TMPDIR: tmp });
	let install = run("bash", installArgs, { env: installEnv, timeoutMs: 300_000 });
	if (!install.ok) {
		// One retry, announced: a transient npm failure must not read as a package defect,
		// and it must not be silent either.
		console.log(`  install retried after: ${install.reason}`);
		install = run("bash", installArgs, { env: installEnv, timeoutMs: 300_000 });
	}
	if (!install.ok) return { error: `install failed: ${install.reason}` };

	// A registry neighbour the case declares: installed into the case's app directory beside
	// the subject's tarball, so the subject's optional import resolves. Recorded as SUPPORT —
	// an empty entry list keeps clauses 2 and 3 judging the case's declared packages alone,
	// while clause 4 counts it installed, which is what makes an absence line naming it fail.
	const registry = [];
	const registrySpecs = caseSpec.requiresInstall ?? [];
	if (registrySpecs.length > 0) {
		const installRegistry = () =>
			run("npm", ["install", "--no-audit", "--no-fund", "--no-save", ...registrySpecs], {
				cwd: appDir,
				env: installEnv,
				timeoutMs: 300_000,
			});
		let registryInstall = installRegistry();
		if (!registryInstall.ok) {
			console.log(`  registry install retried after: ${registryInstall.reason}`);
			registryInstall = installRegistry();
		}
		if (!registryInstall.ok) return { error: `registry install failed: ${registryInstall.reason}` };
		for (const spec of registrySpecs) {
			const name = registrySpecName(spec);
			const dir = path.join(appDir, "node_modules", ...name.split("/"));
			if (!existsSync(dir)) return { error: `registry install placed no ${name} in ${appDir}` };
			const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
			installed.push({ name, version, support: true, dir, entries: [] });
			registry.push(`${name}@${version}`);
		}
	}

	const fixtures = [];
	for (const fixture of caseSpec.fixtures ?? []) {
		const dir = path.join(appDir, "fixtures", fixture.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "package.json"),
			`${JSON.stringify(fixture.packageJson, null, "\t")}\n`,
		);
		for (const [name, content] of Object.entries(fixture.files ?? {})) {
			const target = path.join(dir, name);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
		fixtures.push({
			name: fixture.name,
			dir,
			entries: (fixture.packageJson.pi?.extensions ?? []).map((entry) => path.resolve(dir, entry)),
		});
	}

	const entries = [
		...installed.flatMap((pkg) => pkg.entries.map((entry) => path.resolve(pkg.dir, entry))),
		...fixtures.flatMap((f) => f.entries),
	];
	return {
		appDir,
		home,
		agentDir,
		tmp,
		installed,
		fixtures,
		entries,
		tarballDir,
		support,
		registry,
	};
}

function matrixPiVersion() {
	return JSON.parse(readFileSync(MATRIX_PATH, "utf8")).piVersion ?? "0.86.1";
}

async function orchestrate(args) {
	const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
	const packages = workspacePackages(args.workspace);
	const cases = matrix.cases.filter((entry) => args.case === null || entry.id === args.case);
	if (cases.length === 0) {
		console.error(`no case matches --case ${args.case}`);
		process.exit(2);
	}
	const work = mkdtempSync(path.join(tmpdir(), "pi-matrix-"));
	console.log(`matrix: ${cases.length} case(s) from ${path.relative(process.cwd(), MATRIX_PATH)}`);
	console.log(`workspace: ${packages.size} package(s); tarballs: ${args.tarballs}`);
	const tally = { passed: 0, failed: 0, skipped: 0, controls: 0 };

	for (const caseSpec of cases) {
		const missing = (caseSpec.packages ?? []).filter((name) => !packages.has(name));
		if (missing.length > 0) {
			tally.skipped += 1;
			console.log(`\n${caseSpec.id}  NOT YET PORTED — missing package(s): ${missing.join(", ")}`);
			continue;
		}
		const built = buildCaseDirectory(work, caseSpec, args, packages);
		if (built.skip) {
			tally.skipped += 1;
			console.log(`\n${caseSpec.id}  NOT YET PORTED — missing package: ${built.skip}`);
			continue;
		}
		if (built.error) {
			tally.failed += 1;
			console.log(`\n${caseSpec.id}  FAIL  harness: ${built.error}`);
			continue;
		}
		const specFile = path.join(work, "cases", caseSpec.id, "case-spec.json");
		writeFileSync(
			specFile,
			JSON.stringify(
				{
					appDir: built.appDir,
					agentDir: built.agentDir,
					home: built.home,
					entries: built.entries,
					installed: built.installed,
					fixtures: built.fixtures,
				},
				null,
				"\t",
			),
		);
		const probeFile = path.join(built.appDir, "matrix-probe.mjs");
		cpSync(new URL(import.meta.url).pathname, probeFile);
		const probe = run("node", [probeFile, "--probe", "--probe-spec", specFile], {
			env: withoutPiEnv({
				HOME: built.home,
				XDG_STATE_HOME: path.join(built.home, "state"),
				XDG_RUNTIME_DIR: path.join(built.home, "run"),
				PI_CODING_AGENT_DIR: built.agentDir,
				TMPDIR: built.tmp,
				...Object.fromEntries(Object.entries(caseSpec.env ?? {})),
			}),
			timeoutMs: 180_000,
		});
		if (!probe.ok) {
			tally.failed += 1;
			console.log(`\n${caseSpec.id}  FAIL  harness: probe ${probe.reason}`);
			continue;
		}
		const report = JSON.parse(probe.stdout.trim().split("\n").pop());
		const results = judge(caseSpec, report, {
			appDir: built.appDir,
			installed: built.installed,
			fixtures: built.fixtures,
		});
		const firstFailure = results.find((result) => !result.ok);
		const control = caseSpec.expectFailClause;

		console.log(`\n${caseSpec.id}`);
		console.log(
			`  judged: ${(caseSpec.packages ?? []).join(", ") || "(fixtures only)"}  |  workspace support: ${built.support.join(", ") || "none"}  |  registry: ${built.registry.join(", ") || "none"}`,
		);
		for (const result of results) {
			console.log(`  clause ${result.clause}  ${result.ok ? "pass" : "FAIL"}  ${result.detail}`);
		}
		for (const clause of [1, 2, 3, 4, 5]) {
			if (!results.some((result) => result.clause === clause))
				console.log(`  clause ${clause}  not reached`);
		}
		console.log(
			`  loaded: ${report.loaded.length}  absent lines: ${report.lines.filter((line) => line.kind === "neighbour-absent").length}`,
		);

		if (control !== undefined) {
			tally.controls += 1;
			if (firstFailure && firstFailure.clause === control) {
				console.log(
					`  CONTROL ok — failed clause ${control} as required (${firstFailure.detail.slice(0, 110)})`,
				);
			} else if (firstFailure) {
				tally.failed += 1;
				console.log(
					`  CONTROL FAILED — required a clause ${control} failure, saw clause ${firstFailure.clause}`,
				);
			} else {
				tally.failed += 1;
				console.log(`  CONTROL FAILED — the case passed, so the runner cannot fail`);
			}
			continue;
		}
		if (!args.keep) rmSync(path.join(work, "cases", caseSpec.id), { recursive: true, force: true });

		if (firstFailure) {
			tally.failed += 1;
			console.log(`  CASE FAIL — clause ${firstFailure.clause}: ${firstFailure.detail}`);
		} else {
			tally.passed += 1;
			console.log(`  CASE PASS`);
		}
	}

	console.log(
		`\nmatrix summary: ${tally.passed} passed, ${tally.failed} failed, ${tally.skipped} not yet ported, ${tally.controls} control(s)`,
	);
	if (!args.keep) rmSync(work, { recursive: true, force: true });
	else console.log(`scratch kept at ${work}`);
	process.exit(tally.failed > 0 ? 1 : 0);
}

// ---- judge role: replay a recorded probe report -----------------------------------

/**
 * Judge a probe report recorded earlier (`--probe … > report.json`).
 *
 * This exists so the judging half can be exercised and reviewed on its own: a case's
 * clauses can be argued about without paying for an install, and a control case can be
 * shown to fail on the clause it is supposed to fail on. It is a diagnostic, not a pass —
 * a case is verified only by a matrix run through the shared installer.
 */
async function judgeRecorded(args) {
	const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
	const caseSpec = matrix.cases.find((entry) => entry.id === args.judge);
	if (!caseSpec) {
		console.error(`no case named ${args.judge}`);
		process.exit(2);
	}
	const report = JSON.parse(readFileSync(args.report, "utf8"));
	const spec = JSON.parse(readFileSync(args.probeSpec, "utf8"));
	const results = judge(caseSpec, report, spec);
	const firstFailure = results.find((result) => !result.ok);
	console.log(`judging ${caseSpec.id} from ${args.report}`);
	for (const result of results)
		console.log(`  clause ${result.clause}  ${result.ok ? "pass" : "FAIL"}  ${result.detail}`);
	for (const clause of [1, 2, 3, 4, 5]) {
		if (!results.some((result) => result.clause === clause))
			console.log(`  clause ${clause}  not reached`);
	}
	if (caseSpec.expectFailClause !== undefined) {
		if (firstFailure && firstFailure.clause === caseSpec.expectFailClause) {
			console.log(`  CONTROL ok — failed clause ${caseSpec.expectFailClause} as required`);
			process.exit(0);
		}
		console.log(
			`  CONTROL FAILED — required a clause ${caseSpec.expectFailClause} failure, saw ${firstFailure ? firstFailure.clause : "none"}`,
		);
		process.exit(1);
	}
	process.exit(firstFailure ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2));
if (args.probe) await probeMain(args);
else if (args.judge) await judgeRecorded(args);
else await orchestrate(args);
