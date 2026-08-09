import checkbox from "@inquirer/checkbox";
import select from "@inquirer/select";

type EnvironmentFileAction = "all" | "select" | "none";

export async function selectEnvironmentFiles(
  envFiles: readonly string[],
  selectPrompt: typeof select = select,
  checkboxPrompt: typeof checkbox = checkbox,
): Promise<string[]> {
  if (envFiles.length === 0) return [];
  const action = await selectPrompt<EnvironmentFileAction>({
    message: "What would you like to do with the detected environment files?",
    choices: [
      { name: "Protect all (recommended)", value: "all" },
      { name: "Select individually", value: "select" },
      { name: "Protect none", value: "none" },
    ],
    default: "all",
  });
  if (action === "all") return [...envFiles];
  if (action === "none") return [];
  return await checkboxPrompt<string>({
    message: "Select environment files to protect:",
    choices: envFiles.map((path) => ({
      name: path,
      value: path,
      checked: true,
    })),
  });
}
