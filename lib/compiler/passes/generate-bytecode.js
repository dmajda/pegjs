var utils = require("../../utils"),
    op    = require("../opcodes");

/* Generates bytecode.
 * function interpret(min, max) {...} -- run part of bytecode: bytecode[min:max]
 *
 * Instructions
 * ============
 *
 * Stack Manipulation
 * ------------------
 *
 *  [0] PUSH c
 *
 *        stack.push(consts[c]);
 *
 *  [1] PUSH_CURR_POS
 *
 *        stack.push(currPos);
 *
 *  [2] POP
 *
 *        stack.pop();
 *
 *  [3] POP_CURR_POS
 *
 *        currPos = stack.pop();
 *
 *  [4] POP_N n
 *
 *        stack.pop(n);
 *
 *  [5] NIP
 *
 *        value = stack.pop();
 *        stack.pop();
 *        stack.push(value);
 *
 *  [6] APPEND
 *
 *        value = stack.pop();
 *        array = stack.pop();
 *        array.push(value);
 *        stack.push(array);
 *
 *  [7] WRAP n
 *
 *        stack.push(stack.pop(n));
 *
 *  [8] TEXT
 *
 *        stack.pop();
 *        stack.push(input.substring(stack.top(), currPos));
 *
 * Conditions and Loops
 * --------------------
 *
 *  [9] IF t, f
 *
 *        if (stack.top()) {
 *          interpret(ip + 3, ip + 3 + t);
 *        } else {
 *          interpret(ip + 3 + t, ip + 3 + t + f);
 *        }
 *
 * [10] IF_ERROR t, f
 *
 *        if (stack.top() === FAILED) {
 *          interpret(ip + 3, ip + 3 + t);
 *        } else {
 *          interpret(ip + 3 + t, ip + 3 + t + f);
 *        }
 *
 * [11] IF_NOT_ERROR t, f
 *
 *        if (stack.top() !== FAILED) {
 *          interpret(ip + 3, ip + 3 + t);
 *        } else {
 *          interpret(ip + 3 + t, ip + 3 + t + f);
 *        }
 *
 * [12] IF_ARRLEN_MIN t f
 *
 *        min = stack.pop();
 *        if (typeof min !== "undefined" && stack.top().length < min) {
 *          interpret(ip + 3, ip + 3 + t);
 *        } else {
 *          interpret(ip + 3 + t, ip + 3 + t + f);
 *        }
 *
 * [13] IF_ARRLEN_MAX t f
 *
 *        max = stack.pop();
 *        if (typeof max !== "undefined" && stack.top().length >= max) {
 *          interpret(ip + 3, ip + 3 + t);
 *        } else {
 *          interpret(ip + 3 + t, ip + 3 + t + f);
 *        }
 *
 * [14] WHILE_NOT_ERROR b
 *
 *        while(stack.top() !== FAILED) {
 *          interpret(ip + 2, ip + 2 + b);
 *        }
 *
 * Matching
 * --------
 *
 * [15] MATCH_ANY a, f, ...
 *
 *        if (input.length > currPos) {
 *          interpret(ip + 3, ip + 3 + a);
 *        } else {
 *          interpret(ip + 3 + a, ip + 3 + a + f);
 *        }
 *
 * [16] MATCH_STRING s, a, f, ...
 *
 *        if (input.substr(currPos, consts[s].length) === consts[s]) {
 *          interpret(ip + 4, ip + 4 + a);
 *        } else {
 *          interpret(ip + 4 + a, ip + 4 + a + f);
 *        }
 *
 * [17] MATCH_STRING_IC s, a, f, ...
 *
 *        if (input.substr(currPos, consts[s].length).toLowerCase() === consts[s]) {
 *          interpret(ip + 4, ip + 4 + a);
 *        } else {
 *          interpret(ip + 4 + a, ip + 4 + a + f);
 *        }
 *
 * [18] MATCH_REGEXP r, a, f, ...
 *
 *        if (consts[r].test(input.charAt(currPos))) {
 *          interpret(ip + 4, ip + 4 + a);
 *        } else {
 *          interpret(ip + 4 + a, ip + 4 + a + f);
 *        }
 *
 * [19] ACCEPT_N n
 *
 *        stack.push(input.substring(currPos, n));
 *        currPos += n;
 *
 * [20] ACCEPT_STRING s
 *
 *        stack.push(consts[s]);
 *        currPos += consts[s].length;
 *
 * [21] FAIL e
 *
 *        stack.push(FAILED);
 *        fail(consts[e]);
 *
 * Calls
 * -----
 *
 * [22] REPORT_SAVED_POS p
 *
 *        reportedPos = stack[p];
 *
 * [23] REPORT_CURR_POS
 *
 *        reportedPos = currPos;
 *
 * [24] CALL f, n, pc, p1, p2, ..., pN
 *
 *        value = consts[f](stack[p1], ..., stack[pN]);
 *        stack.pop(n);
 *        stack.push(value);
 *
 * Rules
 * -----
 *
 * [25] RULE r
 *
 *        stack.push(parseRule(r));
 *
 * Failure Reporting
 * -----------------
 *
 * [26] SILENT_FAILS_ON
 *
 *        silentFails++;
 *
 * [27] SILENT_FAILS_OFF
 *
 *        silentFails--;
 *
 */
module.exports = function(ast) {
  var consts = [];
  /// Add new constant to constant list, if it not exist, and return they index in that list.
  function addConst(value) {
    var index = utils.indexOf(consts, function(c) { return c === value; });

    return index === -1 ? consts.push(value) - 1 : index;
  }

  function addFunctionConst(params, code) {
    return addConst(
      "function(" + params.join(", ") + ") {" + code + "}"
    );
  }

  function buildSequence() {
    return Array.prototype.concat.apply([], arguments);
  }

  function buildCondition(condCode, thenCode, elseCode) {
    return condCode.concat(
      [thenCode.length, elseCode.length],
      thenCode,
      elseCode
    );
  }

  function buildLoop(condCode, bodyCode) {
    return condCode.concat([bodyCode.length], bodyCode);
  }

  function buildCall(functionIndex, delta, env, sp) {
    var params = utils.map( utils.values(env), function(p) { return sp - p; });

    return [op.CALL, functionIndex, delta, params.length].concat(params);
  }

  function buildSimplePredicate(expression, negative, context) {
    var undefinedIndex = addConst('void 0'),
        failedIndex    = addConst('peg$FAILED');

    return buildSequence(
      [op.PUSH_CURR_POS],
      [op.SILENT_FAILS_ON],
      generate(expression, {
        sp:     context.sp + 1,
        env:    { },
        action: null
      }),
      [op.SILENT_FAILS_OFF],
      buildCondition(
        [negative ? op.IF_ERROR : op.IF_NOT_ERROR],
        buildSequence(
          [op.POP],
          [negative ? op.POP : op.POP_CURR_POS],
          [op.PUSH, undefinedIndex]
        ),
        buildSequence(
          [op.POP],
          [negative ? op.POP_CURR_POS : op.POP],
          [op.PUSH, failedIndex]
        )
      )
    );
  }

  function buildSemanticPredicate(code, negative, context) {
    var functionIndex  = addFunctionConst(utils.keys(context.env), code),
        undefinedIndex = addConst('void 0'),
        failedIndex    = addConst('peg$FAILED');

    return buildSequence(
      [op.REPORT_CURR_POS],
      buildCall(functionIndex, 0, context.env, context.sp),
      buildCondition(
        [op.IF],
        buildSequence(
          [op.POP],
          [op.PUSH, negative ? failedIndex : undefinedIndex]
        ),
        buildSequence(
          [op.POP],
          [op.PUSH, negative ? undefinedIndex : failedIndex]
        )
      )
    );
  }

  function buildAppendLoop(expressionCode) {
    return buildLoop(
      [op.WHILE_NOT_ERROR],
      buildSequence([op.APPEND], expressionCode)
    );
  }

  var generate = utils.buildNodeVisitor({
    grammar: function(node) {
      utils.each(node.rules, generate);

      node.consts = consts;
    },

    rule: function(node) {
      node.bytecode = generate(node.expression, {
        sp:     -1,  // stack pointer
        env:    { }, // mapping of label names to stack positions
        action: null // action nodes pass themselves to children here
      });
    },

    named: function(node, context) {
      var nameIndex = addConst(
        '{ type: "other", description: ' + utils.quote(node.name) + ' }'
      );

      /*
       * The code generated below is slightly suboptimal because |FAIL| pushes
       * to the stack, so we need to stick a |POP| in front of it. We lack a
       * dedicated instruction that would just report the failure and not touch
       * the stack.
       */
      return buildSequence(
        [op.SILENT_FAILS_ON],
        generate(node.expression, context),
        [op.SILENT_FAILS_OFF],
        buildCondition([op.IF_ERROR], [op.FAIL, nameIndex], [])
      );
    },

    choice: function(node, context) {
      function buildAlternativesCode(alternatives, context) {
        return buildSequence(
          generate(alternatives[0], {
            sp:     context.sp,
            env:    { },
            action: null
          }),
          alternatives.length > 1
            ? buildCondition(
                [op.IF_ERROR],
                buildSequence(
                  [op.POP],
                  buildAlternativesCode(alternatives.slice(1), context)
                ),
                []
              )
            : []
        );
      }

      return buildAlternativesCode(node.alternatives, context);
    },

    action: function(node, context) {
      var env            = { },
          emitCall       = node.expression.type !== "sequence"
                        || node.expression.elements.length === 0,
          expressionCode = generate(node.expression, {
            sp:     context.sp + (emitCall ? 1 : 0),
            env:    env,
            action: node
          }),
          functionIndex  = addFunctionConst(utils.keys(env), node.code);

      return emitCall
        ? buildSequence(
            [op.PUSH_CURR_POS],
            expressionCode,
            buildCondition(
              [op.IF_NOT_ERROR],
              buildSequence(
                [op.REPORT_SAVED_POS, 1],
                buildCall(functionIndex, 1, env, context.sp + 2)
              ),
              []
            ),
            [op.NIP]
          )
        : expressionCode;
    },

    sequence: function(node, context) {
      function buildElementsCode(elements, context) {
        var processedCount, functionIndex;

        if (elements.length > 0) {
          processedCount = node.elements.length - elements.slice(1).length;

          return buildSequence(
            generate(elements[0], {
              sp:     context.sp,
              env:    context.env,
              action: null
            }),
            buildCondition(
              [op.IF_NOT_ERROR],
              buildElementsCode(elements.slice(1), {
                sp:     context.sp + 1,
                env:    context.env,
                action: context.action
              }),
              buildSequence(
                processedCount > 1 ? [op.POP_N, processedCount] : [op.POP],
                [op.POP_CURR_POS],
                [op.PUSH, failedIndex]
              )
            )
          );
        } else {
          if (context.action) {
            functionIndex = addFunctionConst(
              utils.keys(context.env),
              context.action.code
            );

            return buildSequence(
              [op.REPORT_SAVED_POS, node.elements.length],
              buildCall(
                functionIndex,
                node.elements.length,
                context.env,
                context.sp
              ),
              [op.NIP]
            );
          } else {
            return buildSequence([op.WRAP, node.elements.length], [op.NIP]);
          }
        }
      }

      failedIndex = addConst('peg$FAILED');

      return buildSequence(
        [op.PUSH_CURR_POS],
        buildElementsCode(node.elements, {
          sp:     context.sp + 1,
          env:    context.env,
          action: context.action
        })
      );
    },

    labeled: function(node, context) {
      context.env[node.label] = context.sp + 1;

      return generate(node.expression, {
        sp:     context.sp,
        env:    { },
        action: null
      });
    },

    text: function(node, context) {
      return buildSequence(
        [op.PUSH_CURR_POS],
        generate(node.expression, {
          sp:     context.sp + 1,
          env:    { },
          action: null
        }),
        buildCondition([op.IF_NOT_ERROR], [op.TEXT], []),
        [op.NIP]
      );
    },

    simple_and: function(node, context) {
      return buildSimplePredicate(node.expression, false, context);
    },

    simple_not: function(node, context) {
      return buildSimplePredicate(node.expression, true, context);
    },

    semantic_and: function(node, context) {
      return buildSemanticPredicate(node.code, false, context);
    },

    semantic_not: function(node, context) {
      return buildSemanticPredicate(node.code, true, context);
    },

    optional: function(node, context) {
      var nullIndex = addConst('null');

      return buildSequence(
        generate(node.expression, {
          sp:     context.sp,
          env:    { },
          action: null
        }),
        buildCondition(
          [op.IF_ERROR],
          buildSequence([op.POP], [op.PUSH, nullIndex]),
          []
        )
      );
    },

    zero_or_more: function(node, context) {
      var emptyArrayIndex = addConst('[]');
          expressionCode  = generate(node.expression, {
            sp:     context.sp + 1,
            env:    { },
            action: null
          });

      return buildSequence(
        [op.PUSH, emptyArrayIndex],
        expressionCode,
        buildAppendLoop(expressionCode),
        [op.POP]
      );
    },

    one_or_more: function(node, context) {
      var emptyArrayIndex = addConst('[]');
          failedIndex     = addConst('peg$FAILED');
          expressionCode  = generate(node.expression, {
            sp:     context.sp + 1,
            env:    { },
            action: null
          });

      return buildSequence(
        [op.PUSH, emptyArrayIndex],
        expressionCode,
        buildCondition(
          [op.IF_NOT_ERROR],
          buildSequence(buildAppendLoop(expressionCode), [op.POP]),
          buildSequence([op.POP], [op.POP], [op.PUSH, failedIndex])
        )
      );
    },

    range: function(node, context) {
      var emptyArrayIndex = addConst('[]');
      var failedIndex     = addConst('peg$FAILED');
          // expressionCode put result on stack
      var expressionCode  = generate(node.expression, {
            sp:     context.sp + 1,
            env:    { },
            action: null
          });
      var expressionCode2 = node.delimiter ?
          buildSequence(                //                          stack:[  ]
            [op.PUSH_CURR_POS],         // x = peg$currPos;         stack:[ pos ]
            generate(node.delimiter, {  // item = delim();          stack:[ pos, delim ]
              sp:     context.sp + 1,
              env:    { },
              action: null
            }),                         // item = delim();
            buildCondition(
              [op.IF_NOT_ERROR],        // if (item !== peg$FAILED) {
              buildSequence(
                op.POP,                 //                          stack:[ pos ]
                expressionCode,         //   item = expr();         stack:[ pos, item ]
                buildCondition(
                  [op.IF_ERROR],        //   if (item === peg$FAILED) {
                  // If element FAILED, rollback currPos to saved value.
                  [op.POP,              //                          stack:[ pos ]
                   op.POP_CURR_POS,     //     peg$currPos = x;     stack:[  ]
                   op.PUSH, failedIndex],//    item = peg$FAILED;   stack:[ peg$FAILED ]
                  // Else, just drop saved currPos.
                  [op.NIP]              //   }                      stack:[ item ]
                )
              ),                        // }
              // If delimiter FAILED, currPos not changed, so just drop it.
              [op.NIP]                  //                          stack:[ peg$FAILED ]
            )                           //                          stack:[ <?> ]
          ) : expressionCode;//*/
      /*var minIndex        = generate(node.min, {
            sp:     context.sp + 1,
            env:    { },
            action: null
          });
      var maxIndex        = generate(node.max, {
            sp:     context.sp + 1,
            env:    { },
            action: null
          });*/
      var minIndex = addConst(node.min);
      var maxIndex = addConst(node.max);

      return buildSequence(
        [op.PUSH, emptyArrayIndex], // var result = []          stack:[ [] ]
        expressionCode,             // var elem = expr();       stack:[ [], elem ]
        buildLoop(
          [op.WHILE_NOT_ERROR],     // while (elem !== peg$FAILED) {
          buildSequence(
            [op.APPEND],            //   result.push(elem);     stack:[ [elem...] ]
            // Check high boundary.
            [op.PUSH, maxIndex],    //                          stack:[ [elem...], max ]
            buildCondition(         //   if (max !== undefined && result.length >= max) {
              [op.IF_ARRLEN_MAX],   //                          stack:[ [elem...] ]
              // push `peg$FAILED` - this break loop on next iteration.
              [op.PUSH, failedIndex],//    elem = peg$FAILED;   stack:[ [elem...], peg$FAILED ]
              expressionCode2       //   } else {
            )                       //     elem = expr2();      stack:[ [elem...], elem ]
          )                         //   }
        ),                          // }                        stack:[ [elem...], elem ]
        [op.POP],                   //                          stack:[ [elem...] ] (pop elem===`peg$FAILED`)

        // Check low boundary.
        [op.PUSH, minIndex],        //                          stack:[ [elem...], min ]
        buildCondition(             // if (min !== undefined && result.length < min) 
          [op.IF_ARRLEN_MIN],       //                          stack:[ [elem...] ]
          buildSequence(            //   result = peg$FAILED;
            [op.POP],
            [op.PUSH, failedIndex]  //                          stack:[ peg$FAILED ]
          ),
          []
        )
      );                            // return result;           stack:[ result ]
    },

    rule_ref: function(node) {
      return [op.RULE, utils.indexOfRuleByName(ast, node.name)];
    },

    literal: function(node) {
      var stringIndex, expectedIndex;

      if (node.value.length > 0) {
        stringIndex = addConst(node.ignoreCase
          ? utils.quote(node.value.toLowerCase())
          : utils.quote(node.value)
        );
        expectedIndex = addConst([
          '{',
          'type: "literal",',
          'value: ' + utils.quote(node.value) + ',',
          'description: ' + utils.quote(utils.quote(node.value)),
          '}'
        ].join(' '));

        /*
         * For case-sensitive strings the value must match the beginning of the
         * remaining input exactly. As a result, we can use |ACCEPT_STRING| and
         * save one |substr| call that would be needed if we used |ACCEPT_N|.
         */
        return buildCondition(
          node.ignoreCase
            ? [op.MATCH_STRING_IC, stringIndex]
            : [op.MATCH_STRING, stringIndex],
          node.ignoreCase
            ? [op.ACCEPT_N, node.value.length]
            : [op.ACCEPT_STRING, stringIndex],
          [op.FAIL, expectedIndex]
        );
      } else {
        stringIndex = addConst('""');

        return [op.PUSH, stringIndex];
      }
    },

    "class": function(node) {
      var regexp, regexpIndex, expectedIndex;

      if (node.parts.length > 0) {
        regexp = '/^['
          + (node.inverted ? '^' : '')
          + utils.map(node.parts, function(part) {
              return part instanceof Array
                ? utils.quoteForRegexpClass(part[0])
                  + '-'
                  + utils.quoteForRegexpClass(part[1])
                : utils.quoteForRegexpClass(part);
            }).join('')
          + ']/' + (node.ignoreCase ? 'i' : '');
      } else {
        /*
         * IE considers regexps /[]/ and /[^]/ as syntactically invalid, so we
         * translate them into euqivalents it can handle.
         */
        regexp = node.inverted ? '/^[\\S\\s]/' : '/^(?!)/';
      }

      regexpIndex   = addConst(regexp);
      expectedIndex = addConst([
        '{',
        'type: "class",',
        'value: ' + utils.quote(node.rawText) + ',',
        'description: ' + utils.quote(node.rawText),
        '}'
      ].join(' '));

      return buildCondition(
        [op.MATCH_REGEXP, regexpIndex],
        [op.ACCEPT_N, 1],
        [op.FAIL, expectedIndex]
      );
    },

    any: function() {//stack: -0 +1
      var expectedIndex = addConst('{ type: "any", description: "any character" }');

      return buildCondition(
        [op.MATCH_ANY],
        [op.ACCEPT_N, 1],
        [op.FAIL, expectedIndex]
      );
    }
  });

  generate(ast);
};
