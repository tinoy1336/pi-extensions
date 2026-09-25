## [0.2.1](https://github.com/tinoy1336/pi-extensions/compare/build-v0.2.0...build-v0.2.1) (2026-09-25)

### Bug Fixes

* **build:** reach the crew store through the io-guard package ([12ee61c](https://github.com/tinoy1336/pi-extensions/commit/12ee61c58b384a04ea5f50111332b9df1cb6371c))
* **fleet:** admit loader tools at activation ([f69ff8c](https://github.com/tinoy1336/pi-extensions/commit/f69ff8c544e4491c7b577b3b5881bd14792866e8))
* **fleet:** correct the loader exception's rationale ([6f42f3b](https://github.com/tinoy1336/pi-extensions/commit/6f42f3b2b6cb9ab3940833f7862ede7ec3619a87))
* **fleet:** exempt loader tools by name, not by suffix ([97080cf](https://github.com/tinoy1336/pi-extensions/commit/97080cf80282cdf270315ddc836bfe3e6db074c5))
* **fleet:** keep loader tools selected so a wake cannot rewrite the prompt ([ae18529](https://github.com/tinoy1336/pi-extensions/commit/ae18529ad5ebf3fda6a50e0ff150651ae6822f56))

## [0.2.0](https://github.com/tinoy1336/pi-extensions/compare/build-v0.1.0...build-v0.2.0) (2026-09-24)

### Features

* **packages:** name every extension entry index.ts, split io-guard out of fleet ([9d83979](https://github.com/tinoy1336/pi-extensions/commit/9d83979a6a0e0f8db3f6e1cc0481390bb7b959a0))
* **release:** publish a package's first version from a dispatch-only workflow ([372314a](https://github.com/tinoy1336/pi-extensions/commit/372314a942d8c0f574215db9832b82bb6cfd7b45))

### Bug Fixes

* **docker:** count the full set's loaded entries from the manifests ([a78416c](https://github.com/tinoy1336/pi-extensions/commit/a78416c19f465209ad5ceb81c3486e093fcddc99))
* **docker:** expect one extension per fleet package in the matrix ([ba17618](https://github.com/tinoy1336/pi-extensions/commit/ba1761894545760e2c99cd5230c0c85e23bbefdb))
* **release:** publish with the NPM_TOKEN secret instead of OIDC ([202045f](https://github.com/tinoy1336/pi-extensions/commit/202045fef3cfc979b988509d6ec8d9b45da5cf26))
