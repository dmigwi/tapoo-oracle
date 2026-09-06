PNPM := pnpm
DOCKER_IMAGE := tapoo-oracle
DOCKER_VOLUME := tapoo-node-modules
.DEFAULT_GOAL := help

.PHONY: help install audit agentic-analysis typecheck lint test coverage quality ci dev build serve deploy clean observable docker-build docker-run docker-shell check-pnpm check-node check-osv-scanner check-docker

# require stops a target before it starts when a tool it shells out to is not installed.
#
# Without it the recipe runs and the shell answers "osv-scanner: command not found" with status 127.
# That is true and it is also the wrong story: it reads like the audit ran and failed, when the audit
# never happened at all - the difference between "your lockfile is vulnerable" and "nothing checked it".
# Naming the missing tool and how to install it turns a puzzling exit code into an instruction.
#
# command -v rather than which: it is POSIX, it is a shell builtin, and it is what is available in the
# minimal images these targets also run in.
require = @command -v $(1) >/dev/null 2>&1 || { printf 'make: %s is required by this target but is not on PATH.\n      %s\n' '$(1)' '$(2)' >&2; exit 1; }

# The guards are prerequisites rather than lines inside each recipe: a target then names what it needs
# where its dependencies already belong, and the check cannot be forgotten when a recipe grows a second
# command. They carry no ## comment, so they stay out of `make help`.
check-pnpm:
	$(call require,$(PNPM),Install it with "corepack enable" or "npm install -g pnpm".)

check-node:
	$(call require,node,Install Node.js 20 or newer - see https://nodejs.org.)

check-osv-scanner:
	$(call require,osv-scanner,Install it with "brew install osv-scanner" - see https://google.github.io/osv-scanner.)

check-docker:
	$(call require,docker,Install Docker or Colima and make sure the daemon is running.)

help: ## Show available commands.
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: check-pnpm  ## Install the reviewed, locked dependencies.
	CI=true $(PNPM) install --frozen-lockfile --config.confirmModulesPurge=false

audit: check-osv-scanner  ## Fail if the lockfile has known vulnerabilities.
	osv-scanner --lockfile=pnpm-lock.yaml

agentic-analysis: check-node  ## Answer the rubric for exported Tapoo logs; usage: make agentic-analysis LOGS="a.json b.json"
	@test -n "$(LOGS)" || \
		( echo 'Set LOGS to one or more exported logs, e.g. make agentic-analysis LOGS="a.json b.json"' >&2; exit 1 )
	node ./scripts/agentic-analysis.mjs $(LOGS)

typecheck: check-pnpm  ## Type-check the app and the tooling. Nothing is emitted.
	CI=true $(PNPM) --config.confirmModulesPurge=false run typecheck

lint: check-pnpm  ## Run eslint over the app and tooling sources.
	CI=true $(PNPM) --config.confirmModulesPurge=false run lint

test: check-pnpm  ## Run the test suite.
	CI=true $(PNPM) --config.confirmModulesPurge=false run test

coverage: check-pnpm  ## Run the test suite with coverage.
	CI=true $(PNPM) --config.confirmModulesPurge=false run coverage

quality: ## Run the type check, lint and tests.
	$(MAKE) typecheck
	$(MAKE) lint
	$(MAKE) test

ci: ## Run the local equivalent of the CI pipeline.
	$(MAKE) install
	$(MAKE) audit
	$(MAKE) typecheck
	$(MAKE) lint
	$(MAKE) test
	$(MAKE) build

dev: check-pnpm  ## Bundle the app and start the local preview server, rebuilding as sources change.
	$(PNPM) dev

build: check-pnpm  ## Bundle the app, build the static site into ./public, then clean up.
	$(PNPM) build

serve: check-pnpm  ## Serve ./public the way a static host does, with HTML caching off.
	$(PNPM) run serve

deploy: check-pnpm  ## Deploy the app to Observable.
	$(PNPM) deploy

clean: check-pnpm  ## Clear the local data loader cache.
	$(PNPM) clean

observable: check-pnpm  ## Run Observable CLI commands; pass ARGS="help" for example.
	$(PNPM) observable $(ARGS)

docker-build: check-docker  ## Build development image.
	docker build -t $(DOCKER_IMAGE) .

docker-run: check-docker  ## Run project in Colima/Docker.
	docker run --rm -it \
		-p 3000:3000 \
		$(DOCKER_IMAGE)

docker-shell: check-docker  ## Open a shell inside the development container.
	docker run --rm -it \
		-v "$(PWD):/workspace" \
		-v $(DOCKER_VOLUME):/workspace/node_modules \
		$(DOCKER_IMAGE) \
		bash