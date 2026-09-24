## [0.3.0](https://github.com/tinoy1336/pi-extensions/compare/ext-lib-v0.2.0...ext-lib-v0.3.0) (2026-09-24)

### Features

* **packages:** name every extension entry index.ts, split io-guard out of fleet ([9d83979](https://github.com/tinoy1336/pi-extensions/commit/9d83979a6a0e0f8db3f6e1cc0481390bb7b959a0))
* **release:** publish a package's first version from a dispatch-only workflow ([372314a](https://github.com/tinoy1336/pi-extensions/commit/372314a942d8c0f574215db9832b82bb6cfd7b45))
* **release:** publish the five packages held out of the release set ([a35b638](https://github.com/tinoy1336/pi-extensions/commit/a35b638c45c8b58ed6d419f2b2786fc35debc6d8))

### Bug Fixes

* **docker:** count the full set's loaded entries from the manifests ([a78416c](https://github.com/tinoy1336/pi-extensions/commit/a78416c19f465209ad5ceb81c3486e093fcddc99))
* **docker:** expect one extension per fleet package in the matrix ([ba17618](https://github.com/tinoy1336/pi-extensions/commit/ba1761894545760e2c99cd5230c0c85e23bbefdb))
* **release:** publish with the NPM_TOKEN secret instead of OIDC ([202045f](https://github.com/tinoy1336/pi-extensions/commit/202045fef3cfc979b988509d6ec8d9b45da5cf26))
* **release:** refuse an untagged package instead of computing a first version ([8d7a091](https://github.com/tinoy1336/pi-extensions/commit/8d7a0910f510d669c71a0768a2aa9df7558edc6c))
* **sudo-approve:** read an `error:` reply as an answer, not a dead channel ([1ba3248](https://github.com/tinoy1336/pi-extensions/commit/1ba3248d384376badfbb5794b747a62f8d0abfb5))
* **sudo-approve:** resolve the request router from the checkout root ([2cac8aa](https://github.com/tinoy1336/pi-extensions/commit/2cac8aae463a6a5b1395da324c94fc6ba055ffee))

## [0.2.0](https://github.com/tinoy1336/pi-extensions/compare/ext-lib-v0.1.0...ext-lib-v0.2.0) (2026-09-23)

### Features

* **build:** port the bounded build runner as a package ([172ade2](https://github.com/tinoy1336/pi-extensions/commit/172ade21da0b7693e85522af2e2ef604d2673853))
* **cache-prefix-log,child-request-dump:** port the two loggers ([cb274fb](https://github.com/tinoy1336/pi-extensions/commit/cb274fbca85669ba367c005e00761a88aaac04bc))
* **child-prompt-freeze:** port the child prompt pin, and declare the nine payloads ([ac9a6ff](https://github.com/tinoy1336/pi-extensions/commit/ac9a6ff0faab6fb5bda645bcb433a90694122c4c))
* **ci:** check caveats, run the subset matrix, release in dependency order ([01b658f](https://github.com/tinoy1336/pi-extensions/commit/01b658f4ac7ee5750f85f80a771beeaef936404c))
* **command-guard:** port the command guard as a package ([cc37457](https://github.com/tinoy1336/pi-extensions/commit/cc37457242a0cbec137e20a15b215dc38f07ce9b))
* **desktop-notify,probe,intercom-broadcast:** port the three tool units ([80f94da](https://github.com/tinoy1336/pi-extensions/commit/80f94da4403f0bda494a4f71bc9df2ed203dc2ab))
* **image-read:** port the vision-aware image tool as a package ([39e7993](https://github.com/tinoy1336/pi-extensions/commit/39e7993d33ab43e78d87120e60adb70d3eba5992))
* **matrix:** install a case's declared registry neighbours as support ([09d6962](https://github.com/tinoy1336/pi-extensions/commit/09d69620d1b779603bedcb5895c80df9b693fc9c))
* **matrix:** report MATRIX VACUOUS when a run grades nothing ([d013300](https://github.com/tinoy1336/pi-extensions/commit/d0133007688b6f1c38a8f9d2dc56d6a0a478685a))
* **nf:** port the Nerd Font glyph tool as a package ([de4977e](https://github.com/tinoy1336/pi-extensions/commit/de4977ebf60fd7eddd4f63e661bba8d6f2775849))
* **packaging:** add the focus-state and tariff substrate packages ([42ec9da](https://github.com/tinoy1336/pi-extensions/commit/42ec9da3116e0113cd339e6f7af48f3561f10c3e))
* **packaging:** install every tarball in the directory, empty set allowed ([fde1ce6](https://github.com/tinoy1336/pi-extensions/commit/fde1ce610e8c4d124f17b2c2badefa2f3c43f8a3))
* **pause:** ship the pause extension as @tinoy/pi-pause ([8036bb5](https://github.com/tinoy1336/pi-extensions/commit/8036bb5edc6e29491a42542a6c59516ffb13fb03))
* port the six machine-bound units into packages ([eb8a046](https://github.com/tinoy1336/pi-extensions/commit/eb8a0466efc2df075e60619cfdb05c09d38c72a7))
* **read-staleness,orphan-repair,no-subagent-fork:** port the hook-only units ([2522ef6](https://github.com/tinoy1336/pi-extensions/commit/2522ef60e772e1357f0e78c5013ca1540339d61b))
* **release:** release the new packages in dependency order ([7f5e6d0](https://github.com/tinoy1336/pi-extensions/commit/7f5e6d0c7c17cfe45d8560e308353d8c3df01356))
* **status-metrics:** port the footer counters as a package ([7e07955](https://github.com/tinoy1336/pi-extensions/commit/7e079555c3714b5a36ddcecb66f88392aee7c222))
* **todo-parent:** port the crew todo relay as a package ([75a9ef5](https://github.com/tinoy1336/pi-extensions/commit/75a9ef503286134b473020fd1e9e762e16defe8c))

### Bug Fixes

* **ci:** report a vacuous matrix run as MATRIX VACUOUS, not a clause failure ([64237f2](https://github.com/tinoy1336/pi-extensions/commit/64237f20052656c0d20c796e7fac81d48938f9df))
* **deps:** depend on sibling packages by wildcard range ([fc71b08](https://github.com/tinoy1336/pi-extensions/commit/fc71b088b4032ba5808ec29417c045bdd1f43967))
* **ext-lib:** declare an empty extension list so a direct install is inert ([1554636](https://github.com/tinoy1336/pi-extensions/commit/1554636a0f0840a06c8bc0afefa3c387c050dd22))
* **fleet:** guard the board's optional neighbour and free the load path ([a254e7f](https://github.com/tinoy1336/pi-extensions/commit/a254e7fd8e4372218ce87f2ae7c3a5ca0cb1d2e5))
* **matrix:** bound the sweep's scratch, strip PI_* and retry a failed install ([4e24394](https://github.com/tinoy1336/pi-extensions/commit/4e243944b99df246d2d5716a53c311dc3f8258dd))
* **matrix:** stage a case's transitive workspace dependencies ([790248b](https://github.com/tinoy1336/pi-extensions/commit/790248bb3d6a6c5bb5797094931b588b9c5eb0b0))
* **matrix:** stage the workspace manifests into the container image ([89d1232](https://github.com/tinoy1336/pi-extensions/commit/89d12328ad5ca5da8d0308f86ff62493a15fc46c))
* **refusals:** name the missing capability first, as both READMEs promise ([79d1e75](https://github.com/tinoy1336/pi-extensions/commit/79d1e75161963c7f22fe918fdfaf256b4c705153))
* **types:** correct the eight errors against pi's installed API ([0be5eb6](https://github.com/tinoy1336/pi-extensions/commit/0be5eb6c438dcbc6f49113ea111c715237b66390))

## [0.2.0](https://github.com/tinoy1336/pi-extensions/compare/ext-lib-v0.1.0...ext-lib-v0.2.0) (2026-09-23)

### Features

* **build:** port the bounded build runner as a package ([172ade2](https://github.com/tinoy1336/pi-extensions/commit/172ade21da0b7693e85522af2e2ef604d2673853))
* **cache-prefix-log,child-request-dump:** port the two loggers ([cb274fb](https://github.com/tinoy1336/pi-extensions/commit/cb274fbca85669ba367c005e00761a88aaac04bc))
* **child-prompt-freeze:** port the child prompt pin, and declare the nine payloads ([ac9a6ff](https://github.com/tinoy1336/pi-extensions/commit/ac9a6ff0faab6fb5bda645bcb433a90694122c4c))
* **ci:** check caveats, run the subset matrix, release in dependency order ([01b658f](https://github.com/tinoy1336/pi-extensions/commit/01b658f4ac7ee5750f85f80a771beeaef936404c))
* **command-guard:** port the command guard as a package ([cc37457](https://github.com/tinoy1336/pi-extensions/commit/cc37457242a0cbec137e20a15b215dc38f07ce9b))
* **desktop-notify,probe,intercom-broadcast:** port the three tool units ([80f94da](https://github.com/tinoy1336/pi-extensions/commit/80f94da4403f0bda494a4f71bc9df2ed203dc2ab))
* **image-read:** port the vision-aware image tool as a package ([39e7993](https://github.com/tinoy1336/pi-extensions/commit/39e7993d33ab43e78d87120e60adb70d3eba5992))
* **matrix:** install a case's declared registry neighbours as support ([09d6962](https://github.com/tinoy1336/pi-extensions/commit/09d69620d1b779603bedcb5895c80df9b693fc9c))
* **nf:** port the Nerd Font glyph tool as a package ([de4977e](https://github.com/tinoy1336/pi-extensions/commit/de4977ebf60fd7eddd4f63e661bba8d6f2775849))
* **packaging:** add the focus-state and tariff substrate packages ([42ec9da](https://github.com/tinoy1336/pi-extensions/commit/42ec9da3116e0113cd339e6f7af48f3561f10c3e))
* **packaging:** install every tarball in the directory, empty set allowed ([fde1ce6](https://github.com/tinoy1336/pi-extensions/commit/fde1ce610e8c4d124f17b2c2badefa2f3c43f8a3))
* **pause:** ship the pause extension as @tinoy/pi-pause ([8036bb5](https://github.com/tinoy1336/pi-extensions/commit/8036bb5edc6e29491a42542a6c59516ffb13fb03))
* port the six machine-bound units into packages ([eb8a046](https://github.com/tinoy1336/pi-extensions/commit/eb8a0466efc2df075e60619cfdb05c09d38c72a7))
* **read-staleness,orphan-repair,no-subagent-fork:** port the hook-only units ([2522ef6](https://github.com/tinoy1336/pi-extensions/commit/2522ef60e772e1357f0e78c5013ca1540339d61b))
* **release:** release the new packages in dependency order ([7f5e6d0](https://github.com/tinoy1336/pi-extensions/commit/7f5e6d0c7c17cfe45d8560e308353d8c3df01356))
* **status-metrics:** port the footer counters as a package ([7e07955](https://github.com/tinoy1336/pi-extensions/commit/7e079555c3714b5a36ddcecb66f88392aee7c222))
* **todo-parent:** port the crew todo relay as a package ([75a9ef5](https://github.com/tinoy1336/pi-extensions/commit/75a9ef503286134b473020fd1e9e762e16defe8c))

### Bug Fixes

* **ext-lib:** declare an empty extension list so a direct install is inert ([1554636](https://github.com/tinoy1336/pi-extensions/commit/1554636a0f0840a06c8bc0afefa3c387c050dd22))
* **fleet:** guard the board's optional neighbour and free the load path ([a254e7f](https://github.com/tinoy1336/pi-extensions/commit/a254e7fd8e4372218ce87f2ae7c3a5ca0cb1d2e5))
* **matrix:** bound the sweep's scratch, strip PI_* and retry a failed install ([4e24394](https://github.com/tinoy1336/pi-extensions/commit/4e243944b99df246d2d5716a53c311dc3f8258dd))
* **matrix:** stage a case's transitive workspace dependencies ([790248b](https://github.com/tinoy1336/pi-extensions/commit/790248bb3d6a6c5bb5797094931b588b9c5eb0b0))
* **refusals:** name the missing capability first, as both READMEs promise ([79d1e75](https://github.com/tinoy1336/pi-extensions/commit/79d1e75161963c7f22fe918fdfaf256b4c705153))
* **types:** correct the eight errors against pi's installed API ([0be5eb6](https://github.com/tinoy1336/pi-extensions/commit/0be5eb6c438dcbc6f49113ea111c715237b66390))
