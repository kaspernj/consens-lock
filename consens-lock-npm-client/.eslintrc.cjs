module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["jsdoc"],
  extends: ["eslint:recommended", "plugin:jsdoc/recommended"],
  rules: {
    "jsdoc/require-jsdoc": [
      "warn",
      {
        require: {
          FunctionDeclaration: true,
          MethodDefinition: true,
          ClassDeclaration: true,
          ArrowFunctionExpression: false,
          FunctionExpression: false,
        },
      },
    ],
  },
  settings: {
    jsdoc: {
      mode: "jsdoc",
      tagNamePreference: {
        returns: "return",
      },
    },
  },
};
