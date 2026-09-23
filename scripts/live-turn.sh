#!/usr/bin/env bash
# One live model turn against the installed packages.
#
# Manual only: it spends a real model call, which is why the workflow that calls it is
# `workflow_dispatch` and nothing here runs on a push. It installs the packed tarballs
# into a scratch directory, runs pi headlessly with the extension loaded, and asserts
# the turn actually used the extension — the store must gain the line the prompt asks
# for. Loading, registration and the tool schema are covered by the container smoke
# test; what only a live turn can show is that a real model sees the tools and that a
# real call writes the store.
#
# The API key arrives in PI_TEST_API_KEY and is passed to pi only; it is never echoed.
set -euo pipefail

provider="${1:?usage: live-turn.sh <provider> <model> [prompt]}"
model="${2:?usage: live-turn.sh <provider> <model> [prompt]}"
prompt="${3:-Use the canon_category tool with op add and title 'Live turn' to create a category, then call canon_add with text 'live turn check', model 'global', audience 'all' and the category id you just created. Then reply DONE.}"

: "${PI_TEST_API_KEY:?PI_TEST_API_KEY is not set}"

cd "$(dirname "$0")/.."

work="$(mktemp -d "${TMPDIR:-/tmp}/pi-extensions-live-turn.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

tarballs="${work}/tarballs"
mkdir -p "${tarballs}"
timeout 300 npm pack --pack-destination "${tarballs}" -w @tinoy/pi-ext-lib -w @tinoy/pi-canon >/dev/null

app="${work}/app"
bash scripts/stranger-install.sh "${app}" "${tarballs}"

entry="$(
	cd "${app}"
	node -e '
		const fs = require("node:fs");
		const manifest = JSON.parse(
			fs.readFileSync("node_modules/@tinoy/pi-canon/package.json", "utf8"),
		);
		console.log(
			require("node:path").resolve(
				"node_modules/@tinoy/pi-canon",
				manifest.pi.extensions[0],
			),
		);
	'
)"
echo "live turn: provider=${provider} model=${model} extension=${entry}"

cd "${app}"
set +e
HOME="${work}/home" PI_CODING_AGENT_DIR="${work}/agent" timeout 600 \
	"${app}/node_modules/.bin/pi" \
	--provider "${provider}" \
	--model "${model}" \
	--api-key "${PI_TEST_API_KEY}" \
	--extension "${entry}" \
	--no-session \
	-p "${prompt}" 2>&1 | tee "${work}/turn.log"
turn_status="${PIPESTATUS[0]}"
set -e

if [ "${turn_status}" -ne 0 ]; then
	echo "live turn failed: pi exited ${turn_status}" >&2
	exit "${turn_status}"
fi

store="${work}/agent/canon/canon.json"
if [ ! -f "${store}" ]; then
	echo "live turn failed: the model wrote no canon store at ${store}" >&2
	tail -20 "${work}/turn.log" >&2
	exit 1
fi

node -e '
	const fs = require("node:fs");
	const store = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
	const entry = store.entries?.find((candidate) => candidate.text.includes("live turn check"));
	if (!entry) {
		console.error(`live turn failed: no matching entry in ${process.argv[1]}`);
		console.error(JSON.stringify(store));
		process.exit(1);
	}
	console.log(
		`live turn passed: canon_add wrote [${entry.id}] (${entry.model} / ${entry.audience})`,
	);
' "${store}"
