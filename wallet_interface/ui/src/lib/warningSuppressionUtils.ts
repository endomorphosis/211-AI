type ConsoleMethod = "warn" | "log" | "info";

type ConsoleMethodMap = Pick<Console, ConsoleMethod>;

const noisyWarningPatterns = [
  /WebGPU is experimental/i,
  /Failed to create WebGPU Context Provider/i,
  /Implementation-Status#implementation-status/i,
  /Automatic fallback to software WebGL has been deprecated/i,
  /enable-unsafe-swiftshader/i,
  /GroupMarkerNotSet/i,
  /Removing initializer .* It is not used by any node/i,
  /CleanUnusedInitializersAndNodeArgs/i,
  /\[W:onnxruntime:.*graph\.cc:/i,
  /onnxruntime.*unused initializer/i,
];

let originalConsoleMethods: ConsoleMethodMap | null = null;
let activeSuppressionRefs = 0;

export function isKnownNoisyBrowserMlWarning(args: unknown[]): boolean {
  const message = args.map(formatConsoleArgument).join(" ");
  return noisyWarningPatterns.some((pattern) => pattern.test(message));
}

export function setupGlobalWarningSuppressions(): () => void {
  activeSuppressionRefs += 1;

  if (!originalConsoleMethods) {
    originalConsoleMethods = {
      warn: console.warn,
      log: console.log,
      info: console.info,
    };

    console.warn = createFilteredConsoleMethod("warn", originalConsoleMethods);
    console.log = createFilteredConsoleMethod("log", originalConsoleMethods);
    console.info = createFilteredConsoleMethod("info", originalConsoleMethods);
  }

  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    activeSuppressionRefs = Math.max(0, activeSuppressionRefs - 1);
    if (activeSuppressionRefs === 0 && originalConsoleMethods) {
      console.warn = originalConsoleMethods.warn;
      console.log = originalConsoleMethods.log;
      console.info = originalConsoleMethods.info;
      originalConsoleMethods = null;
    }
  };
}

export async function suppressKnownBrowserMlWarnings<T>(operation: () => Promise<T>): Promise<T> {
  const restore = setupGlobalWarningSuppressions();
  try {
    return await operation();
  } finally {
    restore();
  }
}

function createFilteredConsoleMethod(method: ConsoleMethod, originals: ConsoleMethodMap): Console[ConsoleMethod] {
  return (...args: unknown[]) => {
    if (isKnownNoisyBrowserMlWarning(args)) {
      return;
    }
    originals[method].apply(console, args as Parameters<Console[ConsoleMethod]>);
  };
}

function formatConsoleArgument(argument: unknown): string {
  if (typeof argument === "string") {
    return argument;
  }
  if (argument instanceof Error) {
    return `${argument.name}: ${argument.message}`;
  }
  try {
    return JSON.stringify(argument);
  } catch {
    return String(argument);
  }
}
