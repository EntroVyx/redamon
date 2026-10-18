"""
T17 — build-time supply-chain pin regression (recon + Kali images).

Pure text scan of the Dockerfiles and recon/requirements.txt; no docker, no
deps, runs anywhere:  python3 tests/test_t17_build_pins.py

Scope is DELIBERATELY narrow — it locks exactly what the T17 remediation pinned,
and must NOT false-fail on the residuals the commit left unpinned on purpose
(the ProjectDiscovery `go install ...@latest` tools in the Kali image, and the
raw LinEnum/deepce/PowerUp scripts still on their default branch). Those are a
documented residual, not part of this closure.

Locked invariants:
  * recon/Dockerfile has NO `go install ...@latest` (jsluice/ffuf/subjack pinned)
    and clones masscan at a fixed commit.
  * every git+https dependency in recon/requirements.txt carries an @<commit> pin.
  * every SecLists raw-content URL (both images) uses a 40-hex commit, not master.
  * the Kali git-cloned tools that T17 pinned are checked out at a 40-hex commit.
  * neither image uses GitHub `/releases/latest/download/` (moving) URLs.
"""

import os
import re
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RECON_DF = os.path.join(REPO, "recon", "Dockerfile")
KALI_DF = os.path.join(REPO, "mcp", "kali-sandbox", "Dockerfile")
RECON_REQ = os.path.join(REPO, "recon", "requirements.txt")

HEX40 = re.compile(r"^[0-9a-f]{40}$")


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


class TestReconDockerfilePins(unittest.TestCase):
    def setUp(self):
        self.txt = _read(RECON_DF)

    def test_no_go_install_latest(self):
        offenders = re.findall(r"go install[^\n]*@latest", self.txt)
        self.assertEqual(offenders, [], f"unpinned go install @latest: {offenders}")

    def test_go_installs_are_pinned(self):
        # Every `go install <module>@<ref>` in the recon image must pin to a
        # tag or commit (anything but 'latest').
        for mod, ref in re.findall(r"go install[^\n]*?(github\.com/\S+?)@(\S+)", self.txt):
            self.assertNotEqual(ref, "latest", f"{mod} is unpinned")

    def test_masscan_pinned_to_commit(self):
        # clone and checkout span several backslash-continued lines -> DOTALL.
        self.assertIsNotNone(
            re.search(r"masscan\.git.*?checkout\s+[0-9a-f]{40}", self.txt, re.DOTALL),
            "masscan is not checked out at a fixed commit",
        )


class TestReconRequirementsPins(unittest.TestCase):
    def test_all_git_deps_pinned(self):
        txt = _read(RECON_REQ)
        git_deps = re.findall(r"git\+https://\S+", txt)
        self.assertTrue(git_deps, "expected at least one git+ dependency")
        for dep in git_deps:
            # strip trailing comment punctuation
            dep = dep.rstrip(".,")
            self.assertRegex(
                dep, r"\.git@[0-9a-fA-F]{7,40}",
                f"git dependency not pinned to a commit: {dep}",
            )


class TestSecListsPinned(unittest.TestCase):
    def test_seclists_refs_are_commits(self):
        for path in (RECON_DF, KALI_DF):
            txt = _read(path)
            refs = re.findall(r"SecLists/([^/]+)/", txt)
            self.assertTrue(refs, f"no SecLists URL found in {path}")
            for ref in refs:
                self.assertTrue(
                    HEX40.match(ref),
                    f"{os.path.basename(path)}: SecLists ref {ref!r} is not a "
                    f"40-hex commit (mutable branch?)",
                )


class TestKaliGitToolsPinned(unittest.TestCase):
    def setUp(self):
        self.txt = _read(KALI_DF)

    def test_pinned_tools_checked_out_at_commit(self):
        # Tools T17 pinned via `git clone ... && git ... checkout <sha>`.
        pinned_tools = [
            "jwt_tool", "graphql-cop", "graphqlmap", "gMSADumper",
            "sstimap", "tplmap", "phpggc",
            # @Shafranpackeer community-skill accelerators (#206 follow-up).
            # Anchor smuggler on its repo path: 'smuggler.git' is a substring of
            # 'h2csmuggler.git', so a bare 'smuggler' would match the wrong clone.
            "defparam/smuggler", "h2csmuggler",
        ]
        checkouts = re.findall(r"checkout\s+([0-9a-f]{40})", self.txt)
        self.assertGreaterEqual(
            len(checkouts), len(pinned_tools),
            f"expected >= {len(pinned_tools)} commit checkouts, found {len(checkouts)}",
        )
        # Each pinned tool's clone line must be followed (non-greedily -> its
        # OWN checkout) by a 40-hex checkout. Case-insensitive: some repo/dir
        # names are mixed-case (GraphQLmap.git, /opt/gMSADumper).
        for tool in pinned_tools:
            m = re.search(re.escape(tool) + r"\.git.*?checkout\s+[0-9a-f]{40}",
                          self.txt, re.DOTALL | re.IGNORECASE)
            self.assertIsNotNone(m, f"{tool} clone is not pinned to a commit checkout")

    def test_no_releases_latest_download(self):
        offenders = re.findall(r"releases/latest/download", self.txt)
        self.assertEqual(offenders, [], "found moving /releases/latest/download/ URL")


class TestReconNoReleasesLatest(unittest.TestCase):
    def test_recon_no_releases_latest(self):
        self.assertNotIn("releases/latest/download", _read(RECON_DF))


if __name__ == "__main__":
    unittest.main()
