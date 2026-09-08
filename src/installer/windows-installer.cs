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
    private const string AgentContent = "---\ndescription: OpenCode++ guarded coding with repository context and verification gates\nmode: primary\npermission:\n  bash:\n    \"git push*\": ask\n    \"git fetch*\": ask\n    \"git pull*\": ask\n    \"git clone*\": ask\n    \"npm install*\": ask\n    \"npm i*\": ask\n    \"pnpm install*\": ask\n    \"yarn install*\": ask\n    \"pip install*\": ask\n    \"python -m pip install*\": ask\n    \"cargo add*\": ask\n    \"go get*\": ask\n    \"curl*\": ask\n    \"wget*\": ask\n    \"Invoke-WebRequest*\": ask\n    \"Start-BitsTransfer*\": ask\n    \"git reset --hard*\": deny\n    \"git clean*\": deny\n    \"rm -rf*\": deny\n    \"del /s*\": deny\n    \"rmdir /s*\": deny\n    \"Remove-Item* -Recurse*\": deny\n  external_directory: ask\n  webfetch: ask\n  doom_loop: deny\n---\n\nYou are the OpenCode++ primary agent. Use the OpenCode++ plugin tools as the control plane for every concrete coding task.\n\nWorkflow:\n1. Call opencode_plusplus_retrieve when you need to locate task-relevant files.\n2. Call opencode_plusplus_prepare at the start of a concrete coding task, with task and type set to bugfix, feature, or refactor.\n3. Read every file listed in mustInspect before editing.\n4. Edit only files inside allowedEditGlobs and never touch avoidEditGlobs.\n5. Run every requiredCommands entry with the built-in shell tool and preserve the tool result as evidence.\n6. Call opencode_plusplus_evaluate after edits and verification commands.\n7. Keep normal user-facing output compact. Call opencode_plusplus_dashboard only when the user asks for detailed status, you are debugging, or the result requires human-review; it reports recorded decision inputs, not hidden model reasoning.\n8. Call opencode_plusplus_next with the taskId returned by prepare.\n9. If nextAction is not finalize, follow the reported action, then evaluate and call next again. Never claim completion while the decision is blocking or nextAction is not finalize.\n10. Do not run opencode-plusplus CLI commands, Start-Sleep, sleep, or polling loops from Desktop. Use the in-process OpenCode++ plugin tools; if no real repository test command exists, stop at human-review.\n11. In the final response, copy the actionSummary and humanReadable facts from the latest OpenCode++ result. Do not replace them with commit lists, model claims, or test output from outside the plugin.\n12. Do not ask the user to reconfirm work that OpenCode++ already recorded. If the result is human-review, state the exact missing evidence or boundary decision and stop; do not describe human-review as a request to repeat the whole task.\n13. If humanReview.reasonCode is BOUNDARY_EXPANSION_REQUIRED, explain the current and requested paths, then call opencode_plusplus_human_review only after the user explicitly approves with confirmed true. The tool updates the boundary revision and resumes the current task; do not call prepare again. For other reason codes, follow requiredUserAction and resumeCondition without bypassing evidence.\n\nEvidence rules:\n- Do not invent files, commands, test results, or output.\n- Treat stale, manual-only, or superseded evidence according to the policy reported by the plugin.\n- A successful command is not proof of semantic correctness; inspect findings and required evidence before finalizing.\n- Keep changes focused on the requested task and explain any human-review decision.\n\nOpenCode++ is an extensible harness. If this workflow does not fit a repository, customize the plugin agent and runtime in your own fork or project integration rather than bypassing verification silently.\n";
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
            InstallReport report;
            if (HasArgument(args, "--uninstall")) report = Uninstall(paths, HasArgument(args, "--skip-host-patch"));
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
                if (report.action == "installed") MessageBox.Show(report.message + Environment.NewLine + Environment.NewLine + "Restart OpenCode Desktop to load the OpenCode++ mode.", "OpenCode++", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
        return MakeReport("installed", paths, "OpenCode++ mode was installed for the current Windows user.");
    }

    private static InstallReport Uninstall(InstallPaths paths, bool skipLegacyPatchCleanup)
    {
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

    private static InstallReport MakeReport(string action, InstallPaths paths, string message)
    {
        PluginState state = ReadState(paths.stateFile, false);
        bool modeInstalled = File.Exists(paths.agentFile);
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
            message = message
        };
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
        if (!File.Exists(file)) return new PluginState { schemaVersion = 1, revision = 0, enabled = true };
        try
        {
            Dictionary<string, object> data = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
            return new PluginState
            {
                schemaVersion = Number(data, "schemaVersion", 1),
                revision = Number(data, "revision", 0),
                enabled = !data.ContainsKey("enabled") || Convert.ToBoolean(data["enabled"]),
                version = Text(data, "version"),
                installedAt = Text(data, "installedAt"),
                updatedAt = Text(data, "updatedAt")
            };
        }
        catch (Exception error)
        {
            if (failOnCorrupt) throw new InvalidOperationException("OpenCode++ state is corrupt: " + error.Message);
            return new PluginState { schemaVersion = 1, revision = 0, enabled = true };
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
    }

    private sealed class ErrorReport
    {
        public bool ok;
        public string error;
    }
}
