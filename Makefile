PNPM ?= pnpm

.DEFAULT_GOAL := help

.PHONY: help install audit ci dev build deploy clean observable

help: ## Show available commands.
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the reviewed, locked dependencies.
	CI=true $(PNPM) install --frozen-lockfile --config.confirmModulesPurge=false

audit: ## Fail if the lockfile has known vulnerabilities.
	$(PNPM) audit --audit-level=low

ci: ## Run the install, audit, and production build checks.
	$(MAKE) install
	$(MAKE) audit
	$(MAKE) build

dev: ## Start the local preview server.
	$(PNPM) dev

build: ## Build the static site into ./dist.
	$(PNPM) build

deploy: ## Deploy the app to Observable.
	$(PNPM) deploy

clean: ## Clear the local data loader cache.
	$(PNPM) clean

observable: ## Run Observable CLI commands; pass ARGS="help" for example.
	$(PNPM) observable $(ARGS)
