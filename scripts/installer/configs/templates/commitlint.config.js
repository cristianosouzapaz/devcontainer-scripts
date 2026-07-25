export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"body-max-line-length": [2, "always", 200],
		"footer-max-line-length": [2, "always", 200],
		"header-max-length": [2, "always", 100],
		"type-enum": [
			2,
			"always",
			["build", "chore", "ci", "config", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"],
		],
	},
};
