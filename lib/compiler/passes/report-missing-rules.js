var GrammarError = require("../../grammar-error"),
    asts         = require("../asts"),
    visitor      = require("../visitor");

/* Checks that all referenced rules exist. */
function reportMissingRules(ast) {
  var check = visitor.build({
    range: function(node) {
      check(node.expression);
      if (node.delimiter !== null) {
        check(node.delimiter);
      }
    },
    rule_ref: function(node) {
      if (!asts.findRule(ast, node.name)) {
        throw new GrammarError(
          "Referenced rule \"" + node.name + "\" does not exist."
        );
      }
    }
  });

  check(ast);
}

module.exports = reportMissingRules;
