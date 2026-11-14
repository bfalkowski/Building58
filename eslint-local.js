// The repo's own ESLint rules, wired in eslint.config.js. No package: ESLint loads this file as a plugin.
//
// local/no-comments flags a comment in product code. Two kinds stay allowed:
// - the header block: every comment before the file's first line of code;
// - an eslint-disable comment that gives its reason after ` -- `, and eslint-enable.
// The comments that existed when the rule came in are recorded in eslint-suppressions.json, so only
// a new comment fails lint. See "Comments in product code" in README.md.
'use strict';

const MESSAGE = 'No new comments: put a rule in a test or lint rule, behavior in docs/manual, and history in the pull request.';
const DIRECTIVE = /^\s*eslint-(disable|disable-line|disable-next-line)\s.*\s--\s*\S/;
const ENABLE = /^\s*eslint-enable\b/;

const noComments = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow comments in product code, except the header block and reasoned eslint-disable lines' },
    schema: [],
    messages: { comment: MESSAGE }
  },
  create(context) {
    const source = context.sourceCode;
    return {
      Program(node) {
        const first = source.getFirstToken(node, { includeComments: false });
        const codeStart = first ? first.range[0] : Infinity;
        for (const comment of source.getAllComments()) {
          if (comment.type === 'Shebang') continue;
          if (comment.range[1] <= codeStart) continue;
          if (DIRECTIVE.test(comment.value) || ENABLE.test(comment.value)) continue;
          context.report({ loc: comment.loc, messageId: 'comment' });
        }
      }
    };
  }
};

module.exports = { meta: { name: 'local' }, rules: { 'no-comments': noComments } };
