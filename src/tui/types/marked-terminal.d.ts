declare module 'marked-terminal' {
  interface TerminalRendererOptions {
    showSectionPrefix?: boolean;
    reflowText?: boolean;
    width?: number;
  }
  class TerminalRenderer {
    constructor(options?: TerminalRendererOptions);
  }
  export default TerminalRenderer;
}
