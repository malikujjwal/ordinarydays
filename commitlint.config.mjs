// Conventional Commits, plus the project-specific `infra` type that
// docs/04-conventions/git-workflow.md §2.1 defines and that
// @commitlint/config-conventional does not know about.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'perf',
        'refactor',
        'test',
        'docs',
        'build',
        'ci',
        'infra',
        'chore',
        'revert',
      ],
    ],
  },
};
