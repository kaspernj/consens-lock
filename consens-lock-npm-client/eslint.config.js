// @ts-check

import jsdoc from "eslint-plugin-jsdoc";

export default [
  {
    ignores: ["node_modules/**", "db/**", "tmp/**"]
  },
  jsdoc.configs["flat/recommended"],
  {
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        console: "readonly",
        globalThis: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        fetch: "readonly"
      },
      sourceType: "module"
    },
    plugins: { jsdoc },
    rules: {
      "jsdoc/require-jsdoc": [
        "warn",
        {
          require: {
            ArrowFunctionExpression: false,
            ClassDeclaration: true,
            FunctionDeclaration: true,
            FunctionExpression: false,
            MethodDefinition: true
          }
        }
      ]
    },
    settings: {
      jsdoc: {
        mode: "jsdoc",
        tagNamePreference: {
          returns: "return"
        }
      }
    }
  }
];
