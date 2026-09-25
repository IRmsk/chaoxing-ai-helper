/// <reference types="vite/client" />

/** 以字符串形式引入 CSS 的模块声明（Shadow DOM 注入样式时使用）。 */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
