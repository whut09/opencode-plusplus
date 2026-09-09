using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("OpenCode++ Windows Installer")]
[assembly: AssemblyProduct("OpenCode++")]
[assembly: AssemblyVersion("__PACKAGE_VERSION__.0")]
[assembly: AssemblyFileVersion("__PACKAGE_VERSION__.0")]

internal static class OpenCodePlusPlusInstaller
{
    private const string PackageVersion = "__PACKAGE_VERSION__";
    private const string PluginResource = "OpenCodePlusPlus.Plugin.gz";
    private const string PluginFileName = "opencode-plusplus.js";
    private const string AgentFileName = "agents/opencode-plusplus.md";
    private const string LegacyPatchMarker = "OPENCODE_PLUSPLUS_NATIVE_COMMANDS";
    private const string PluginVersionMarker = "OPENCODE_PLUS_PLUS_PLUGIN_VERSION";
    private const int HealthSchemaVersion = 1;
    private const string AgentContent = "---\ndescription: OpenCode++ guarded coding with repository context and verification gates\nmode: primary\npermission:\n  bash:\n    \"git push*\": ask\n    \"git fetch*\": ask\n    \"git pull*\": ask\n    \"git clone*\": ask\n    \"npm install*\": ask\n    \"npm i*\": ask\n    \"pnpm install*\": ask\n    \"yarn install*\": ask\n    \"pip install*\": ask\n    \"python -m pip install*\": ask\n    \"cargo add*\": ask\n    \"go get*\": ask\n    \"curl*\": ask\n    \"wget*\": ask\n    \"Invoke-WebRequest*\": ask\n    \"Start-BitsTransfer*\": ask\n    \"git reset --hard*\": deny\n    \"git clean*\": deny\n    \"rm -rf*\": deny\n    \"del /s*\": deny\n    \"rmdir /s*\": deny\n    \"Remove-Item* -Recurse*\": deny\n  external_directory: ask\n  webfetch: ask\n  doom_loop: deny\n---\n\nYou are the OpenCode++ primary agent. Use the OpenCode++ plugin tools as the control plane for every concrete coding task.\n\nWorkflow:\n1. Call opencode_plusplus_retrieve when you need to locate task-relevant files.\n2. When a new Desktop session reports resume candidates, call opencode_plusplus_resume with action inspect. Never resume from a task id alone; call action resume only with confirmed true after selecting a same-repository candidate. A resume-verification candidate continues evaluation, a stale-task candidate rebuilds context, and a mismatched repository is never restored.\n3. Call opencode_plusplus_prepare at the start of a concrete coding task, with task and type set to bugfix, feature, or refactor.\n4. Read every file listed in mustInspect before editing.\n5. Edit only files inside allowedEditGlobs and never touch avoidEditGlobs.\n6. Run every requiredCommands entry with the built-in shell tool and preserve the tool result as evidence.\n7. Call opencode_plusplus_evaluate after edits and verification commands.\n8. Keep normal user-facing output compact. Call opencode_plusplus_dashboard only when the user asks for detailed status, you are debugging, or the result requires human-review; it reports recorded decision inputs, not hidden model reasoning.\n9. Call opencode_plusplus_next with the taskId returned by prepare or resume.\n10. If nextAction is not finalize, follow the reported action, then evaluate and call next again. Never claim completion while the decision is blocking or nextAction is not finalize.\n11. Do not run opencode-plusplus CLI commands, Start-Sleep, sleep, or polling loops from Desktop. Use the in-process OpenCode++ plugin tools; if no real repository test command exists, stop at human-review.\n12. In the final response, copy the actionSummary and humanReadable facts from the latest OpenCode++ result. Do not replace them with commit lists, model claims, or test output from outside the plugin.\n13. Do not ask the user to reconfirm work that OpenCode++ already recorded. If the result is human-review, state the exact missing evidence or boundary decision and stop; do not describe human-review as a request to repeat the whole task.\n14. If humanReview.reasonCode is BOUNDARY_EXPANSION_REQUIRED, explain the current and requested paths, then call opencode_plusplus_human_review only after the user explicitly approves with confirmed true. The tool updates the boundary revision and resumes the current task; do not call prepare again. For other reason codes, follow requiredUserAction and resumeCondition without bypassing evidence.\n\nEvidence rules:\n- Do not invent files, commands, test results, or output.\n- Treat stale, manual-only, or superseded evidence according to the policy reported by the plugin.\n- A successful command is not proof of semantic correctness; inspect findings and required evidence before finalizing.\n- Keep changes focused on the requested task and explain any human-review decision.\n\nOpenCode++ is an extensible harness. If this workflow does not fit a repository, customize the plugin agent and runtime in your own fork or project integration rather than bypassing verification silently.\n";
    private static readonly JavaScriptSerializer Json = CreateJsonSerializer();

    private static JavaScriptSerializer CreateJsonSerializer()
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = Int32.MaxValue;
        return serializer;
    }

    [STAThread]
    public static int Main(string[] args)
    {
        bool machineOutput = HasArgument(args, "--json") || HasArgument(args, "--silent");
        try
        {
            InstallPaths paths = ResolvePaths(ArgumentValue(args, "--config-dir"));
            if (HasArgument(args, "--doctor") || HasArgument(args, "--health"))
            {
                HealthReport health = MakeHealthReport(paths);
                if (machineOutput) Console.WriteLine(Json.Serialize(health));
                else Console.WriteLine(RenderHealth(health));
                return health.ok ? 0 : 1;
            }
            InstallReport report;
            if (HasArgument(args, "--uninstall")) report = Uninstall(paths, HasArgument(args, "--skip-host-patch"));
            else if (HasArgument(args, "--repair")) report = Repair(paths, HasArgument(args, "--skip-host-patch"));
            else if (HasArgument(args, "--status")) report = MakeReport("status", paths, "OpenCode++ installation status.");
            else if (HasArgument(args, "--enable")) report = SetEnabled(paths, true);
            else if (HasArgument(args, "--disable")) report = SetEnabled(paths, false);
            else report = Install(paths, HasArgument(args, "--skip-host-patch"));

            if (machineOutput) Console.WriteLine(Json.Serialize(report));
            else
            {
                Console.WriteLine(report.message);
                Console.WriteLine("Config: " + report.paths.configDir);
                Console.WriteLine("Plugin: " + (report.pluginExists ? "installed" : "not installed"));
                Console.WriteLine("Mode: " + (report.modeInstalled ? "opencode-plusplus" : "not installed"));
                Console.WriteLine("Enabled: " + (report.enabled ? "yes" : "no"));
                if (report.action == "installed" || report.action == "repaired") MessageBox.Show(RenderInstallSuccess(report), "OpenCode++", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return report.ok ? 0 : 1;
        }
        catch (Exception error)
        {
            if (machineOutput) Console.Error.WriteLine(Json.Serialize(new ErrorReport { ok = false, error = error.Message }));
            else
            {
                Console.Error.WriteLine(error);
                MessageBox.Show(error.Message, "OpenCode++ installation failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return 1;
        }
    }

    private static InstallReport Install(InstallPaths paths, bool skipLegacyPatchCleanup)
    {
        EnsureMutationAllowed(MakeHealthReport(paths), "install");
        if (!skipLegacyPatchCleanup) RestoreLegacyHostPatchIfPresent();
        AtomicWrite(paths.pluginFile, ReadPlugin());
        int removed = RemoveLegacyFiles(paths);
        AtomicWrite(paths.agentFile, Encoding.UTF8.GetBytes(AgentContent));
        PluginState current = ReadState(paths.stateFile, true);
        DateTime now = DateTime.UtcNow;
        AtomicWriteJson(paths.stateFile, new PluginState
        {
            schemaVersion = 1,
            revision = current.revision + 1,
            enabled = current.enabled,
            version = PackageVersion,
            installedAt = String.IsNullOrEmpty(current.installedAt) ? Iso(now) : current.installedAt,
            updatedAt = Iso(now)
        });
        WriteInstallationManifest(paths, removed, now);
        return MakeReport("installed", paths, "OpenCode++ mode was installed for the current Windows user.");
    }

    private static InstallReport Repair(InstallPaths paths, bool skipLegacyPatchCleanup)
    {
        HealthReport health = MakeHealthReport(paths);
        EnsureMutationAllowed(health, "repair");
        if (!skipLegacyPatchCleanup) RestoreLegacyHostPatchIfPresent();
        byte[] plugin = ReadPlugin();
        if (!health.pluginInstalled || health.pluginVersion != PackageVersion || HasProblem(health, "PLUGIN_INVALID") || HasProblem(health, "PLUGIN_VERSION_UNKNOWN"))
        {
            AtomicWrite(paths.pluginFile, plugin);
            health.repairedItems.Add("plugin");
        }
        if (!health.agentInstalled || !AgentMatches(paths.agentFile))
        {
            AtomicWrite(paths.agentFile, Encoding.UTF8.GetBytes(AgentContent));
            health.repairedItems.Add("agent");
        }

        bool stateNeedsRepair = health.runtimeState.status != "valid" || health.runtimeState.version != PackageVersion;
        if (stateNeedsRepair)
        {
            DateTime now = DateTime.UtcNow;
            PluginState current = health.runtimeState.status == "corrupt" ? new PluginState { schemaVersion = 1, revision = 0, enabled = true } : ReadState(paths.stateFile, false);
            AtomicWriteJson(paths.stateFile, new PluginState
            {
                schemaVersion = 1,
                revision = current.revision + 1,
                enabled = health.runtimeState.status == "corrupt" ? true : current.enabled,
                version = PackageVersion,
                installedAt = String.IsNullOrEmpty(current.installedAt) ? Iso(now) : current.installedAt,
                updatedAt = Iso(now)
            });
            health.repairedItems.Add("runtime state");
        }

        int removed = RemoveLegacyFiles(paths);
        if (health.manifest.status != "valid" || HasProblem(health, "MANIFEST_MISMATCH"))
        {
            WriteInstallationManifest(paths, removed, DateTime.UtcNow);
            health.repairedItems.Add("installation manifest");
        }
        else if (removed > 0) health.repairedItems.Add("legacy files");
        string message = health.repairedItems.Count == 0 ? "OpenCode++ installation is healthy." : "OpenCode++ repaired: " + String.Join(", ", health.repairedItems.ToArray()) + ".";
        return MakeReport("repaired", paths, message, health.repairedItems);
    }

    private static InstallReport Uninstall(InstallPaths paths, bool skipLegacyPatchCleanup)
    {
        EnsureMutationAllowed(MakeHealthReport(paths), "uninstall");
        if (!skipLegacyPatchCleanup) RestoreLegacyHostPatchIfPresent();
        DeleteOwnedFile(paths.pluginFile);
        DeleteOwnedFile(paths.manifestFile);
        DeleteOwnedFile(paths.stateFile);
        DeleteOwnedFile(paths.agentFile);
        RemoveLegacyFiles(paths);
        RemoveEmptyDirectory(Path.GetDirectoryName(paths.manifestFile));
        RemoveEmptyDirectory(Path.GetDirectoryName(paths.agentFile));
        RemoveEmptyDirectory(Path.GetDirectoryName(Path.GetDirectoryName(paths.agentFile)));
        return MakeReport("uninstalled", paths, "OpenCode++ was removed from the current Windows user.");
    }

    private static InstallReport SetEnabled(InstallPaths paths, bool enabled)
    {
        EnsureMutationAllowed(MakeHealthReport(paths), enabled ? "enable" : "disable");
        PluginState current = ReadState(paths.stateFile, true);
        DateTime now = DateTime.UtcNow;
        AtomicWriteJson(paths.stateFile, new PluginState
        {
            schemaVersion = 1,
            revision = current.revision + 1,
            enabled = enabled,
            version = PackageVersion,
            installedAt = String.IsNullOrEmpty(current.installedAt) ? Iso(now) : current.installedAt,
            updatedAt = Iso(now)
        });
        return MakeReport(enabled ? "enabled" : "disabled", paths, "OpenCode++ is now " + (enabled ? "enabled." : "disabled."));
    }

    private static InstallReport MakeReport(string action, InstallPaths paths, string message, List<string> repairedItems = null)
    {
        PluginState state = ReadState(paths.stateFile, false);
        bool modeInstalled = File.Exists(paths.agentFile);
        HealthReport health = MakeHealthReport(paths);
        List<string> completedRepairs = repairedItems ?? new List<string>();
        health.repairedItems = completedRepairs;
        return new InstallReport
        {
            action = action,
            ok = action == "uninstalled" || (File.Exists(paths.pluginFile) && modeInstalled),
            version = PackageVersion,
            paths = paths,
            pluginExists = File.Exists(paths.pluginFile),
            enabled = state.enabled,
            modeInstalled = modeInstalled,
            commandsInstalled = 0,
            agentFilesInstalled = modeInstalled ? 1 : 0,
            legacyFilesRemoved = 0,
            message = action == "installed" ? "OpenCode++ " + PackageVersion + " installed successfully." : message,
            health = health,
            repairedItems = completedRepairs
        };
    }

    private static HealthReport MakeHealthReport(InstallPaths paths)
    {
        string version = PackageVersion;
        StateRead state = ReadStateDiagnostic(paths.stateFile);
        ManifestRead manifest = ReadManifestDiagnostic(paths.manifestFile);
        bool pluginInstalled = File.Exists(paths.pluginFile);
        string pluginSource = ReadTextOrNull(paths.pluginFile);
        bool pluginValid = pluginSource != null && pluginSource.IndexOf("OpenCodePlusPlusGlobalPlugin", StringComparison.Ordinal) >= 0;
        string pluginVersion = pluginSource == null ? null : ExtractPluginVersion(pluginSource);
        bool agentInstalled = File.Exists(paths.agentFile);
        bool agentValid = agentInstalled && AgentMatches(paths.agentFile);
        bool configDirectoryExists = Directory.Exists(paths.configDir);
        bool configPathInvalid = File.Exists(paths.configDir);
        bool configDirectoryWritable = !configPathInvalid && (configDirectoryExists ? CanWriteDirectory(paths.configDir) : CanWriteNearestDirectory(paths.configDir));
        bool openCodeProcessDetected = OpenCodeRunning();
        List<HealthProblem> problems = new List<HealthProblem>();

        if (configPathInvalid) AddProblem(problems, "CONFIG_PATH_INVALID", "error", "The OpenCode config path exists but is not a directory.", paths.configDir);
        else if (!configDirectoryWritable) AddProblem(problems, "CONFIG_PATH_UNWRITABLE", "error", "The OpenCode config directory is not writable for the current user.", paths.configDir);
        if (!pluginInstalled) AddProblem(problems, "PLUGIN_MISSING", "error", "The OpenCode++ plugin file is missing.", paths.pluginFile);
        else if (!pluginValid) AddProblem(problems, "PLUGIN_INVALID", "error", "The OpenCode++ plugin file does not contain the expected plugin entry.", paths.pluginFile);
        else if (String.IsNullOrEmpty(pluginVersion)) AddProblem(problems, "PLUGIN_VERSION_UNKNOWN", "warning", "The installed plugin has no OpenCode++ version marker; run --repair to refresh it.", paths.pluginFile);
        else if (pluginVersion != version) AddProblem(problems, "PLUGIN_VERSION_MISMATCH", "error", "The installed plugin is version " + pluginVersion + ", but this installer is version " + version + ".", paths.pluginFile);
        if (!agentInstalled) AddProblem(problems, "AGENT_MISSING", "error", "The OpenCode++ primary agent file is missing.", paths.agentFile);
        else if (!agentValid) AddProblem(problems, "AGENT_INVALID", "error", "The OpenCode++ agent file is not the expected primary mode.", paths.agentFile);
        if (state.status == "missing") AddProblem(problems, "STATE_MISSING", "error", "The OpenCode++ runtime state file is missing.", paths.stateFile);
        else if (state.status == "corrupt") AddProblem(problems, "STATE_CORRUPT", "error", state.diagnostic, paths.stateFile);
        else if (state.status == "unsupported") AddProblem(problems, "STATE_SCHEMA_UNSUPPORTED", "error", state.diagnostic, paths.stateFile);
        else if (!String.IsNullOrEmpty(state.state.version) && state.state.version != version) AddProblem(problems, "STATE_VERSION_MISMATCH", "error", "The runtime state is version " + state.state.version + ", but this installer is version " + version + ".", paths.stateFile);
        if (manifest.status == "missing") AddProblem(problems, "MANIFEST_MISSING", "error", "The OpenCode++ installation manifest is missing.", paths.manifestFile);
        else if (manifest.status == "corrupt") AddProblem(problems, "MANIFEST_CORRUPT", "error", manifest.diagnostic, paths.manifestFile);
        else if (manifest.status != "valid" || !ManifestMatches(manifest, paths, version)) AddProblem(problems, "MANIFEST_MISMATCH", "error", "The installation manifest does not match the current OpenCode++ files or version.", paths.manifestFile);

        bool installed = pluginInstalled || agentInstalled || manifest.status != "missing" || state.status != "missing";
        bool healthy = installed && problems.Count == 0;
        HealthReport report = new HealthReport
        {
            schemaVersion = HealthSchemaVersion,
            checkedAt = Iso(DateTime.UtcNow),
            version = version,
            configPath = paths.configDir,
            pluginTarget = paths.pluginFile,
            agentTarget = paths.agentFile,
            stateFile = paths.stateFile,
            manifestFile = paths.manifestFile,
            configDirectoryExists = configDirectoryExists,
            configDirectoryWritable = configDirectoryWritable,
            openCodeProcessDetected = openCodeProcessDetected,
            existingInstallationVersion = !String.IsNullOrEmpty(manifest.version) ? manifest.version : state.state.version,
            pluginInstalled = pluginInstalled,
            pluginVersion = pluginVersion,
            agentInstalled = agentInstalled,
            enabled = state.state.enabled,
            installed = installed,
            healthy = healthy,
            ok = healthy,
            manifest = ToFileHealth(manifest, paths.manifestFile),
            runtimeState = ToFileHealth(state, paths.stateFile),
            problems = problems,
            recommendedActions = RecommendedActions(problems, installed, openCodeProcessDetected),
            repairedItems = new List<string>()
        };
        return report;
    }

    private static void EnsureMutationAllowed(HealthReport health, string action)
    {
        if (health.openCodeProcessDetected) throw new InvalidOperationException("OpenCode Desktop is running. Fully exit OpenCode Desktop before running the OpenCode++ installer.");
        if (HasProblem(health, "CONFIG_PATH_INVALID") || HasProblem(health, "CONFIG_PATH_UNWRITABLE")) throw new InvalidOperationException("Cannot " + action + " OpenCode++: the OpenCode config directory is invalid or not writable (" + health.configPath + ").");
        if (action == "install" && (HasProblem(health, "STATE_CORRUPT") || HasProblem(health, "MANIFEST_CORRUPT"))) throw new InvalidOperationException("Cannot install over corrupt OpenCode++ metadata. Run --repair first, or use --doctor --json for details.");
        if (action != "uninstall" && action != "repair" && HasProblem(health, "STATE_CORRUPT")) throw new InvalidOperationException("Cannot " + action + " OpenCode++ while its state file is corrupt. Run --repair first.");
    }

    private static string RenderHealth(HealthReport report)
    {
        List<string> lines = new List<string>
        {
            "OpenCode++ Doctor",
            "",
            "Version: " + report.version,
            "Config: " + report.configPath,
            "Plugin: " + (report.pluginInstalled ? "installed" : "missing") + (String.IsNullOrEmpty(report.pluginVersion) ? "" : " (" + report.pluginVersion + ")"),
            "Agent: " + (report.agentInstalled ? "installed" : "missing"),
            "Enabled: " + (report.enabled ? "yes" : "no"),
            "Manifest: " + report.manifest.status,
            "Runtime state: " + report.runtimeState.status,
            "OpenCode Desktop process: " + (report.openCodeProcessDetected ? "detected" : "not detected"),
            "Overall: " + (report.healthy ? "healthy" : report.installed ? "needs attention" : "not installed"),
            "",
            "Problems:"
        };
        if (report.problems.Count == 0) lines.Add("- none");
        else foreach (HealthProblem problem in report.problems) lines.Add("- [" + problem.severity.ToUpperInvariant() + "] " + problem.code + ": " + problem.message);
        lines.Add("");
        lines.Add("Recommended actions:");
        if (report.recommendedActions.Count == 0) lines.Add("- none");
        else foreach (string action in report.recommendedActions) lines.Add("- " + action);
        return String.Join(Environment.NewLine, lines.ToArray());
    }

    private static string RenderInstallSuccess(InstallReport report)
    {
        return "OpenCode++ " + report.version + " " + (report.action == "repaired" ? "repaired successfully" : "installed successfully") + Environment.NewLine + Environment.NewLine +
            "Config:" + Environment.NewLine + report.paths.configDir + Environment.NewLine +
            "Plugin:" + Environment.NewLine + (report.pluginExists ? "OK" : "FAILED") + Environment.NewLine +
            "Agent:" + Environment.NewLine + (report.modeInstalled ? "OK" : "FAILED") + Environment.NewLine + Environment.NewLine +
            "Next:" + Environment.NewLine + "1. Restart OpenCode Desktop" + Environment.NewLine + "2. Select OpenCode++" + Environment.NewLine + "3. Describe your task normally";
    }

    private static bool HasProblem(HealthReport report, string code)
    {
        foreach (HealthProblem problem in report.problems) if (problem.code == code) return true;
        return false;
    }

    private static void AddProblem(List<HealthProblem> problems, string code, string severity, string message, string file)
    {
        problems.Add(new HealthProblem { code = code, severity = severity, message = String.IsNullOrEmpty(message) ? code : message, path = file });
    }

    private static List<string> RecommendedActions(List<HealthProblem> problems, bool installed, bool openCodeProcessDetected)
    {
        foreach (HealthProblem problem in problems) if (problem.code == "CONFIG_PATH_INVALID") return new List<string> { "Set OPENCODE_CONFIG_DIR to a directory used by OpenCode Desktop." };
        foreach (HealthProblem problem in problems) if (problem.code == "CONFIG_PATH_UNWRITABLE") return new List<string> { "Choose a writable OpenCode config directory or fix its permissions." };
        if (!installed) return new List<string> { "Run the OpenCode++ Windows installer." };
        foreach (HealthProblem problem in problems) if (problem.code == "STATE_CORRUPT" || problem.code == "MANIFEST_CORRUPT") return new List<string> { (openCodeProcessDetected ? "Fully exit OpenCode Desktop before changing the installation." : "Close OpenCode Desktop before changing the installation."), "Run the installer with --repair.", "Use --doctor --json to inspect the diagnostic report." };
        if (problems.Count > 0) return new List<string> { (openCodeProcessDetected ? "Fully exit OpenCode Desktop before changing the installation." : "Close OpenCode Desktop before changing the installation."), "Run the installer with --repair.", "Restart OpenCode Desktop after repair." };
        return new List<string> { "Restart OpenCode Desktop after changing enabled state or upgrading the plugin." };
    }

    private static bool AgentMatches(string file)
    {
        try { return File.ReadAllText(file, Encoding.UTF8) == AgentContent; }
        catch { return false; }
    }

    private static string ReadTextOrNull(string file)
    {
        try { return File.Exists(file) ? File.ReadAllText(file, Encoding.UTF8) : null; }
        catch { return null; }
    }

    private static string ExtractPluginVersion(string source)
    {
        string marker = PluginVersionMarker + ":";
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0) return null;
        string value = source.Substring(start + marker.Length).Trim();
        int end = value.IndexOfAny(new[] { ' ', '\t', '\r', '\n', '*', '/' });
        return end < 0 ? value : value.Substring(0, end);
    }

    private static bool ManifestMatches(ManifestRead manifest, InstallPaths paths, string version)
    {
        return manifest.status == "valid" && manifest.version == version && manifest.plugin == PluginFileName && manifest.agent == AgentFileName && manifest.mode == "opencode-plusplus";
    }

    private static FileHealth ToFileHealth(StateRead state, string file)
    {
        return new FileHealth { status = state.status, path = file, version = state.state.version, revision = state.state.revision, diagnostic = state.diagnostic };
    }

    private static FileHealth ToFileHealth(ManifestRead manifest, string file)
    {
        return new FileHealth { status = manifest.status, path = file, version = manifest.version, revision = manifest.revision, diagnostic = manifest.diagnostic, plugin = manifest.plugin, mode = manifest.mode, agent = manifest.agent };
    }

    private static bool CanWriteNearestDirectory(string directory)
    {
        string current = Path.GetFullPath(directory);
        while (!Directory.Exists(current))
        {
            string parent = Path.GetDirectoryName(current);
            if (String.IsNullOrEmpty(parent) || parent == current) return false;
            current = parent;
        }
        return CanWriteDirectory(current);
    }

    private static bool CanWriteDirectory(string directory)
    {
        string probe = Path.Combine(directory, ".opencode-plusplus-health-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (FileStream stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Flush(true); }
            DeleteOwnedFile(probe);
            return true;
        }
        catch
        {
            DeleteOwnedFile(probe);
            return false;
        }
    }

    private static void WriteInstallationManifest(InstallPaths paths, int removed, DateTime now)
    {
        AtomicWriteJson(paths.manifestFile, new InstallationManifest
        {
            schemaVersion = 2,
            revision = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            version = PackageVersion,
            installedAt = Iso(now),
            plugin = PluginFileName,
            mode = "opencode-plusplus",
            agent = AgentFileName,
            commands = new string[0],
            legacyFilesRemoved = removed
        });
    }

    private static InstallPaths ResolvePaths(string configuredDirectory)
    {
        string root = configuredDirectory;
        if (String.IsNullOrWhiteSpace(root)) root = Environment.GetEnvironmentVariable("OPENCODE_CONFIG_DIR");
        if (String.IsNullOrWhiteSpace(root))
        {
            string xdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
            root = String.IsNullOrWhiteSpace(xdg) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "opencode") : Path.Combine(xdg, "opencode");
        }
        root = Path.GetFullPath(root);
        List<string> legacy = new List<string>();
        foreach (string name in new[] { "opencode-plusplus-on.md", "opencode-plusplus-off.md", "opencode-plusplus-status.md", "plusplus-task.md", "plusplus-verify.md" }) legacy.Add(Path.Combine(root, "commands", name));
        legacy.Add(Path.Combine(root, "skills", "opencode-plusplus", "SKILL.md"));
        return new InstallPaths
        {
            configDir = root,
            pluginFile = Path.Combine(root, "plugins", PluginFileName),
            stateFile = Path.Combine(root, "opencode-plusplus", "state.json"),
            manifestFile = Path.Combine(root, "opencode-plusplus", "installation.json"),
            agentFile = Path.Combine(root, AgentFileName.Replace('/', Path.DirectorySeparatorChar)),
            legacyFiles = legacy.ToArray()
        };
    }

    private static int RemoveLegacyFiles(InstallPaths paths)
    {
        int removed = 0;
        foreach (string file in paths.legacyFiles)
        {
            if (!File.Exists(file)) continue;
            DeleteOwnedFile(file);
            removed++;
        }
        return removed;
    }

    private static byte[] ReadPlugin()
    {
        Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(PluginResource);
        if (resource == null) throw new InvalidOperationException("Embedded OpenCode++ plugin is missing.");
        using (resource)
        using (GZipStream gzip = new GZipStream(resource, CompressionMode.Decompress))
        using (MemoryStream output = new MemoryStream())
        {
            gzip.CopyTo(output);
            byte[] plugin = output.ToArray();
            if (plugin.Length == 0) throw new InvalidOperationException("Embedded OpenCode++ plugin is empty.");
            return plugin;
        }
    }

    private static PluginState ReadState(string file, bool failOnCorrupt)
    {
        StateRead result = ReadStateDiagnostic(file);
        if (result.status == "corrupt" && failOnCorrupt) throw new InvalidOperationException("OpenCode++ state is corrupt: " + result.diagnostic);
        return result.state;
    }

    private static StateRead ReadStateDiagnostic(string file)
    {
        PluginState fallback = new PluginState { schemaVersion = 1, revision = 0, enabled = true };
        if (!File.Exists(file)) return new StateRead { status = "missing", state = fallback };
        try
        {
            Dictionary<string, object> data = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
            if (data == null) throw new InvalidOperationException("Runtime state must be a JSON object.");
            object schemaValue;
            int schema = data.TryGetValue("schemaVersion", out schemaValue) && schemaValue != null ? Convert.ToInt32(schemaValue) : 0;
            PluginState state = new PluginState
            {
                schemaVersion = schema,
                revision = Number(data, "revision", 0),
                enabled = !data.ContainsKey("enabled") || Convert.ToBoolean(data["enabled"]),
                version = Text(data, "version"),
                installedAt = Text(data, "installedAt"),
                updatedAt = Text(data, "updatedAt")
            };
            return new StateRead
            {
                status = state.schemaVersion == 1 ? "valid" : "unsupported",
                state = state,
                diagnostic = state.schemaVersion == 1 ? null : schema == 0 ? "Runtime state has no schemaVersion." : "Unsupported state schema " + state.schemaVersion + "."
            };
        }
        catch (Exception error)
        {
            return new StateRead { status = "corrupt", state = fallback, diagnostic = error.Message };
        }
    }

    private static ManifestRead ReadManifestDiagnostic(string file)
    {
        if (!File.Exists(file)) return new ManifestRead { status = "missing" };
        try
        {
            Dictionary<string, object> data = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
            if (data == null) throw new InvalidOperationException("Installation manifest must be a JSON object.");
            object schemaValue;
            if (!data.TryGetValue("schemaVersion", out schemaValue)) return new ManifestRead { status = "unsupported", diagnostic = "Installation manifest has no schemaVersion." };
            int schema = Convert.ToInt32(schemaValue);
            ManifestRead manifest = new ManifestRead
            {
                status = schema == 2 ? "valid" : "unsupported",
                version = Text(data, "version"),
                revision = NumberLong(data, "revision"),
                plugin = Text(data, "plugin"),
                mode = Text(data, "mode"),
                agent = Text(data, "agent")
            };
            if (manifest.status != "valid") manifest.diagnostic = "Unsupported installation manifest schema " + schema + ".";
            return manifest;
        }
        catch (Exception error)
        {
            return new ManifestRead { status = "corrupt", diagnostic = error.Message };
        }
    }

    private static void RestoreLegacyHostPatchIfPresent()
    {
        string asar = FindHostAsar();
        if (asar == null || !ContainsMarker(asar)) return;
        if (OpenCodeRunning()) throw new InvalidOperationException("Close OpenCode Desktop completely before removing the legacy OpenCode++ host patch.");
        string backup = asar + ".opencode-plusplus.original";
        if (!File.Exists(backup)) throw new InvalidOperationException("The legacy OpenCode++ host patch is active, but its original app.asar backup is missing.");
        AtomicReplace(backup, asar);
        DeleteOwnedFile(backup);
        DeleteOwnedFile(asar + ".opencode-plusplus.json");
    }

    private static string FindHostAsar()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        foreach (string candidate in new[] { Path.Combine(local, "Programs", "@opencode-aidesktop", "resources", "app.asar"), Path.Combine(local, "Programs", "OpenCode", "resources", "app.asar") }) if (File.Exists(candidate)) return candidate;
        return null;
    }

    private static bool ContainsMarker(string file)
    {
        byte[] source = File.ReadAllBytes(file);
        byte[] marker = Encoding.UTF8.GetBytes(LegacyPatchMarker);
        for (int start = 0; start <= source.Length - marker.Length; start++)
        {
            bool match = true;
            for (int index = 0; index < marker.Length; index++) if (source[start + index] != marker[index]) { match = false; break; }
            if (match) return true;
        }
        return false;
    }

    private static bool OpenCodeRunning()
    {
        try { return System.Diagnostics.Process.GetProcessesByName("OpenCode").Length > 0; }
        catch { return false; }
    }

    private static void AtomicWrite(string file, byte[] content)
    {
        string directory = Path.GetDirectoryName(file);
        Directory.CreateDirectory(directory);
        string temporary = file + ".tmp-" + Guid.NewGuid().ToString("N");
        using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            stream.Write(content, 0, content.Length);
            stream.Flush(true);
        }
        AtomicReplace(temporary, file);
    }

    private static void AtomicWriteJson(string file, object value) { AtomicWrite(file, Encoding.UTF8.GetBytes(Json.Serialize(value) + Environment.NewLine)); }

    private static void AtomicReplace(string source, string target)
    {
        if (File.Exists(target)) File.Replace(source, target, null);
        else File.Move(source, target);
    }

    private static void DeleteOwnedFile(string file) { try { if (File.Exists(file)) File.Delete(file); } catch { } }

    private static void RemoveEmptyDirectory(string directory)
    {
        try { if (!String.IsNullOrEmpty(directory) && Directory.Exists(directory) && Directory.GetFiles(directory).Length == 0 && Directory.GetDirectories(directory).Length == 0) Directory.Delete(directory); } catch { }
    }

    private static int Number(Dictionary<string, object> data, string key, int fallback)
    {
        object value;
        return data.TryGetValue(key, out value) && value != null ? Convert.ToInt32(value) : fallback;
    }

    private static long? NumberLong(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) && value != null ? (long?)Convert.ToInt64(value) : null;
    }

    private static string Text(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : null;
    }

    private static string ArgumentValue(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static bool HasArgument(string[] args, string name) { return Array.IndexOf(args, name) >= 0; }
    private static string Iso(DateTime value) { return value.ToUniversalTime().ToString("o"); }

    private sealed class InstallPaths
    {
        public string configDir;
        public string pluginFile;
        public string stateFile;
        public string manifestFile;
        public string agentFile;
        public string[] legacyFiles;
    }

    private sealed class PluginState
    {
        public int schemaVersion;
        public int revision;
        public bool enabled;
        public string version;
        public string installedAt;
        public string updatedAt;
    }

    private sealed class InstallationManifest
    {
        public int schemaVersion;
        public long revision;
        public string version;
        public string installedAt;
        public string plugin;
        public string mode;
        public string agent;
        public string[] commands;
        public int legacyFilesRemoved;
    }

    private sealed class InstallReport
    {
        public string action;
        public bool ok;
        public string version;
        public InstallPaths paths;
        public bool pluginExists;
        public bool enabled;
        public bool modeInstalled;
        public int commandsInstalled;
        public int agentFilesInstalled;
        public int legacyFilesRemoved;
        public string message;
        public HealthReport health;
        public List<string> repairedItems;
    }

    private sealed class HealthReport
    {
        public int schemaVersion;
        public string checkedAt;
        public string version;
        public string configPath;
        public string pluginTarget;
        public string agentTarget;
        public string stateFile;
        public string manifestFile;
        public bool configDirectoryExists;
        public bool configDirectoryWritable;
        public bool openCodeProcessDetected;
        public string existingInstallationVersion;
        public bool pluginInstalled;
        public string pluginVersion;
        public bool agentInstalled;
        public bool enabled;
        public bool installed;
        public bool healthy;
        public bool ok;
        public FileHealth manifest;
        public FileHealth runtimeState;
        public List<HealthProblem> problems;
        public List<string> recommendedActions;
        public List<string> repairedItems;
    }

    private sealed class FileHealth
    {
        public string status;
        public string path;
        public string version;
        public long? revision;
        public string diagnostic;
        public string plugin;
        public string mode;
        public string agent;
    }

    private sealed class HealthProblem
    {
        public string code;
        public string severity;
        public string message;
        public string path;
    }

    private sealed class StateRead
    {
        public string status;
        public PluginState state;
        public string diagnostic;
    }

    private sealed class ManifestRead
    {
        public string status;
        public string version;
        public long? revision;
        public string plugin;
        public string mode;
        public string agent;
        public string diagnostic;
    }

    private sealed class ErrorReport
    {
        public bool ok;
        public string error;
    }
}
