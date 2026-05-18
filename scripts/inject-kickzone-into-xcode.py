#!/usr/bin/env python3
"""
Add the native KickZone Swift sources to ios/App/App.xcodeproj/project.pbxproj.

This is the equivalent of dragging the KickZone folder into Xcode and choosing
"Create groups → Add to App target". The .pbxproj is a stable text format so
we can patch it directly without needing xcodegen.

What it does:
  - Generates a stable 24-char hex UUID per file (hash of filename so reruns
    are idempotent — same filename always gets the same UUID).
  - Creates one PBXGroup per source subdir (Models, Game, AI, Rendering,
    Controls, UI, Resources) under the App group.
  - Adds a PBXFileReference for every .swift / .json.
  - Adds a PBXBuildFile referencing each, in Sources (swift) or Resources
    (json) phase as appropriate.
  - Wires the new groups into the App group's children list.
  - Wires the new BuildFiles into the Sources / Resources phase children
    lists.

Idempotent: running it twice is safe — duplicate UUIDs are skipped.
"""
import hashlib
import os
import re
import sys

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
PBXPROJ = os.path.join(PROJECT_ROOT, "ios/App/App.xcodeproj/project.pbxproj")
KICKZONE = os.path.join(PROJECT_ROOT, "ios/App/App/KickZone")

# The App group ID is hard-coded in the pbxproj (see the file we read).
APP_GROUP_ID = "504EC3061FED79650016851F"
SOURCES_PHASE_ID = "504EC3001FED79650016851F"
RESOURCES_PHASE_ID = "504EC3021FED79650016851F"

SWIFT_SUBDIRS = ["Models", "Game", "AI", "Rendering", "Controls", "UI"]


def stable_uuid(name: str) -> str:
    """Deterministic 24-char hex UUID — same name always maps to same id."""
    h = hashlib.md5(name.encode()).hexdigest().upper()
    return h[:24]


def collect_files():
    """Returns list of (relative_path_from_KickZone, abs_path, kind).
    kind is 'swift' or 'json' (skips other files like README.md)."""
    out = []
    for sub in SWIFT_SUBDIRS:
        d = os.path.join(KICKZONE, sub)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if f.endswith(".swift"):
                out.append((f"{sub}/{f}", os.path.join(d, f), "swift"))
    res = os.path.join(KICKZONE, "Resources")
    if os.path.isdir(res):
        for f in sorted(os.listdir(res)):
            if f.endswith(".json"):
                out.append((f"Resources/{f}", os.path.join(res, f), "json"))
    return out


def main():
    if not os.path.exists(PBXPROJ):
        print(f"error: pbxproj not found at {PBXPROJ}", file=sys.stderr)
        sys.exit(1)

    files = collect_files()
    if not files:
        print("error: no source files found in KickZone/", file=sys.stderr)
        sys.exit(1)

    pbx = open(PBXPROJ, "r").read()

    # ----------------------------------------------------------
    # 1. Generate the IDs we need (stable per-name)
    # ----------------------------------------------------------
    # Per-file: PBXFileReference + PBXBuildFile
    # Per-group: PBXGroup
    refs = []
    for rel, abs_path, kind in files:
        fname = os.path.basename(rel)
        file_ref_id = stable_uuid(f"FileRef:{rel}")
        build_id = stable_uuid(f"Build:{rel}")
        refs.append({
            "rel": rel,
            "fname": fname,
            "kind": kind,
            "file_ref_id": file_ref_id,
            "build_id": build_id,
        })

    group_ids = {}
    kickzone_group_id = stable_uuid("Group:KickZone")
    group_ids["KickZone"] = kickzone_group_id
    for sub in SWIFT_SUBDIRS + ["Resources"]:
        group_ids[sub] = stable_uuid(f"Group:KickZone/{sub}")

    # ----------------------------------------------------------
    # 2. Build the text blocks to inject
    # ----------------------------------------------------------
    # PBXBuildFile entries
    build_file_lines = []
    for r in refs:
        in_phase = "Sources" if r["kind"] == "swift" else "Resources"
        build_file_lines.append(
            f'\t\t{r["build_id"]} /* {r["fname"]} in {in_phase} */ = '
            f'{{isa = PBXBuildFile; fileRef = {r["file_ref_id"]} /* {r["fname"]} */; }};'
        )

    # PBXFileReference entries
    file_ref_lines = []
    for r in refs:
        if r["kind"] == "swift":
            file_type = "sourcecode.swift"
        else:
            file_type = "text.json"
        file_ref_lines.append(
            f'\t\t{r["file_ref_id"]} /* {r["fname"]} */ = '
            f'{{isa = PBXFileReference; lastKnownFileType = {file_type}; '
            f'path = {r["fname"]}; sourceTree = "<group>"; }};'
        )

    # PBXGroup entries — one per subdir + the KickZone parent
    group_lines = []
    # Sub-groups (each contains its own files)
    for sub in SWIFT_SUBDIRS + ["Resources"]:
        children_refs = [r for r in refs if r["rel"].startswith(sub + "/")]
        if not children_refs:
            continue
        children_text = "\n".join(
            f'\t\t\t\t{r["file_ref_id"]} /* {r["fname"]} */,'
            for r in children_refs
        )
        group_lines.append(f"""\t\t{group_ids[sub]} /* {sub} */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
{children_text}
\t\t\t);
\t\t\tpath = {sub};
\t\t\tsourceTree = "<group>";
\t\t}};""")

    # Parent KickZone group — children are the sub-groups
    sub_children_text = "\n".join(
        f'\t\t\t\t{group_ids[sub]} /* {sub} */,'
        for sub in SWIFT_SUBDIRS + ["Resources"]
        if any(r["rel"].startswith(sub + "/") for r in refs)
    )
    group_lines.append(f"""\t\t{kickzone_group_id} /* KickZone */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
{sub_children_text}
\t\t\t);
\t\t\tpath = KickZone;
\t\t\tsourceTree = "<group>";
\t\t}};""")

    # ----------------------------------------------------------
    # 3. Patch the pbxproj
    # ----------------------------------------------------------
    # Skip everything if the IDs are already present (idempotent)
    if kickzone_group_id in pbx:
        print("KickZone references already present — nothing to do.")
        return

    # Inject PBXBuildFile entries
    pbx = pbx.replace(
        "/* End PBXBuildFile section */",
        "\n".join(build_file_lines) + "\n/* End PBXBuildFile section */",
        1,
    )

    # Inject PBXFileReference entries
    pbx = pbx.replace(
        "/* End PBXFileReference section */",
        "\n".join(file_ref_lines) + "\n/* End PBXFileReference section */",
        1,
    )

    # Inject PBXGroup entries
    pbx = pbx.replace(
        "/* End PBXGroup section */",
        "\n".join(group_lines) + "\n/* End PBXGroup section */",
        1,
    )

    # Add KickZone group to the App group's children
    app_group_re = re.compile(
        r"(" + APP_GROUP_ID + r" /\* App \*/ = \{\s*isa = PBXGroup;\s*children = \(\s*)",
        re.DOTALL,
    )
    pbx = app_group_re.sub(
        r"\1" + f"\t\t\t\t{kickzone_group_id} /* KickZone */,\n\t\t\t",
        pbx,
        count=1,
    )

    # Add Swift build files to Sources phase
    sources_re = re.compile(
        r"(" + SOURCES_PHASE_ID + r" /\* Sources \*/ = \{\s*isa = PBXSourcesBuildPhase;[^}]*?files = \(\s*)",
        re.DOTALL,
    )
    swift_build_lines = "\n".join(
        f'\t\t\t\t{r["build_id"]} /* {r["fname"]} in Sources */,'
        for r in refs if r["kind"] == "swift"
    )
    pbx = sources_re.sub(
        r"\1" + swift_build_lines + "\n\t\t\t",
        pbx,
        count=1,
    )

    # Add JSON build files to Resources phase
    resources_re = re.compile(
        r"(" + RESOURCES_PHASE_ID + r" /\* Resources \*/ = \{\s*isa = PBXResourcesBuildPhase;[^}]*?files = \(\s*)",
        re.DOTALL,
    )
    json_build_lines = "\n".join(
        f'\t\t\t\t{r["build_id"]} /* {r["fname"]} in Resources */,'
        for r in refs if r["kind"] == "json"
    )
    pbx = resources_re.sub(
        r"\1" + json_build_lines + "\n\t\t\t",
        pbx,
        count=1,
    )

    # ----------------------------------------------------------
    # 4. Write back
    # ----------------------------------------------------------
    open(PBXPROJ, "w").write(pbx)
    print(f"injected {len(refs)} files into project.pbxproj")
    swift_count = sum(1 for r in refs if r["kind"] == "swift")
    json_count = sum(1 for r in refs if r["kind"] == "json")
    print(f"  - {swift_count} swift sources")
    print(f"  - {json_count} json resources")
    print("now: build in Xcode (⌘R)")


if __name__ == "__main__":
    main()
