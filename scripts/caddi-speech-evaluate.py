#!/usr/bin/env python3
"""Isolated, pinned synthetic speech evaluation. Default is a read-only plan.

--download creates a fresh ignored input directory; --execute --inputs PATH
creates a fresh evaluation directory. No microphone, server, install or resume.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import selectors
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import wave
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / ".test-artifacts/caddi-speech"
COMMIT = "d1be6fde11ac6e0407606b4e42fe72d34add8037"
MODEL_COMMIT = "5359861c739e955e79d9a303bcbc70fb988958b1"
PINS = {
    "source": {"file": "whisper.tar.gz", "url": "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/" + COMMIT,
               "sha256": "645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4", "bytes": 9631456},
    "cmake": {"file": "cmake.whl", "url": "https://files.pythonhosted.org/packages/7f/09/516b0d709672bc430eb13278f0316acd34869269447744f5d136daeef689/cmake-3.31.6-py3-none-macosx_10_10_universal2.whl",
              "sha256": "da9d4fd9abd571fd016ddb27da0428b10277010b23bb21e3678f8b9e96e1686e", "bytes": 47224338},
    "model": {"file": "ggml-tiny.en.bin", "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/" + MODEL_COMMIT + "/ggml-tiny.en.bin",
              "sha256": "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f", "bytes": 77704715},
}
PROMPTS = [
    ("layout", "Move the search field above the project list and keep the save button visible."),
    ("constraint", "Do not submit the form. Select the second tab and show me the error message."),
    ("name", "Caddi should remember this workspace and restore my pinned tabs when I open the browser."),
]
VOICES = ["Samantha", "Daniel"]
CONFIG = {
    "CMAKE_BUILD_TYPE": "Release", "CMAKE_OSX_ARCHITECTURES": "arm64",
    "CMAKE_C_COMPILER": "/usr/bin/clang", "CMAKE_CXX_COMPILER": "/usr/bin/clang++",
    "CMAKE_MAKE_PROGRAM": "/usr/bin/make", "BUILD_SHARED_LIBS": "OFF",
    "CMAKE_FIND_USE_PACKAGE_REGISTRY": "OFF", "CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY": "OFF",
    "CMAKE_EXPORT_NO_PACKAGE_REGISTRY": "ON", "FETCHCONTENT_FULLY_DISCONNECTED": "ON",
    "WHISPER_BUILD_IS_DEV": "OFF", "WHISPER_BUILD_COMMIT": COMMIT, "WHISPER_BUILD_NUMBER": "0",
    "WHISPER_BUILD_TESTS": "OFF", "WHISPER_BUILD_EXAMPLES": "ON", "WHISPER_BUILD_SERVER": "OFF",
    "WHISPER_CURL": "OFF", "WHISPER_SDL2": "OFF", "WHISPER_COREML": "OFF", "WHISPER_OPENVINO": "OFF",
    "GGML_CPU": "ON", "GGML_ACCELERATE": "ON", "GGML_BLAS": "ON", "GGML_BLAS_VENDOR": "Apple",
    "GGML_METAL": "OFF", "GGML_METAL_EMBED_LIBRARY": "OFF", "GGML_OPENMP": "OFF",
    "GGML_OPENMP_FETCH": "OFF", "GGML_CPU_KLEIDIAI": "OFF", "GGML_CCACHE": "OFF",
    "GGML_RPC": "OFF", "GGML_CUDA": "OFF", "GGML_VULKAN": "OFF", "GGML_BACKEND_DL": "OFF",
}
RESERVE = 5 * 1024 ** 3
MAX_LOG = 2 * 1024 ** 2
MAX_EXPANDED = 256 * 1024 ** 2
CANCELLED = False


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def contained(path, parent):
    path, parent = Path(path).absolute(), Path(parent).absolute()
    require(path == path.resolve() and parent == parent.resolve(), "Noncanonical or symlink path")
    require(path != parent and parent in path.parents, "Path is outside the evaluation root")
    return path


def fresh_directory(prefix):
    require(not BASE.is_symlink(), "Symlink evaluation root")
    BASE.mkdir(parents=True, exist_ok=True)
    require(BASE == BASE.resolve(), "Noncanonical evaluation root")
    require(shutil.disk_usage(BASE).free >= RESERVE, "Evaluation disk reserve is unavailable")
    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(BASE)))


def verify_resource(path, pin):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid(), "Input must be an owned regular file")
    require(info.st_size == pin["bytes"], "Input size differs from the pin")
    require(digest(path) == pin["sha256"], "Input SHA256 differs from the pin")


def member_path(name):
    require(isinstance(name, str) and name and "\\" not in name and "\x00" not in name, "Unsafe archive name")
    path = PurePosixPath(name)
    require(not path.is_absolute() and ".." not in path.parts and str(path) != ".", "Archive path escape")
    return path


def extract_archive(archive_path, destination, kind, prefix=None):
    destination = Path(destination)
    require(not destination.exists() and not destination.is_symlink(), "Extraction destination already exists")
    archive = tarfile.open(archive_path, "r:gz") if kind == "tar" else zipfile.ZipFile(archive_path)
    with archive:
        members = archive.getmembers() if kind == "tar" else archive.infolist()
        require(len(members) <= 10000, "Archive entry limit")
        entries, seen, expanded = [], set(), 0
        for item in members:
            name = item.name if kind == "tar" else item.filename
            path = member_path(name)
            is_dir = item.isdir() if kind == "tar" else item.is_dir()
            if kind == "tar":
                require(item.isfile() or is_dir, "Archive links/devices are not allowed")
            else:
                mode = (item.external_attr >> 16) & 0o170000
                require(mode in (0, stat.S_IFREG, stat.S_IFDIR), "Archive links/devices are not allowed")
            if prefix:
                require(path.parts[0] == prefix, "Unexpected source archive prefix")
                if len(path.parts) == 1:
                    require(is_dir, "Invalid source archive root")
                    continue
                path = PurePosixPath(*path.parts[1:])
            folded = str(path).casefold()
            require(folded not in seen, "Duplicate or case-aliased archive path")
            seen.add(folded)
            size = item.size if kind == "tar" else item.file_size
            expanded += size
            require(size >= 0 and expanded <= MAX_EXPANDED, "Archive expansion limit")
            entries.append((item, path, is_dir, size))
        destination.mkdir(mode=0o700)
        for item, relative, is_dir, size in entries:
            target = destination.joinpath(*relative.parts)
            if is_dir:
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with (archive.extractfile(item) if kind == "tar" else archive.open(item)) as reader, target.open("xb") as writer:
                remaining = size
                while remaining:
                    chunk = reader.read(min(1024 * 1024, remaining))
                    require(chunk, "Truncated archive member")
                    writer.write(chunk)
                    remaining -= len(chunk)
            os.chmod(target, 0o600)
        return {"entries": len(entries), "expandedBytes": expanded}


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        host = parsed.hostname or ""
        require(parsed.scheme == "https" and not parsed.username and
                (host in ("codeload.github.com", "files.pythonhosted.org", "huggingface.co") or host.endswith(".hf.co")),
                "Download redirect is outside approved public distribution hosts")
        return super().redirect_request(request, fp, code, message, headers, newurl)


def download():
    work = fresh_directory("inputs-")
    records = []
    opener = urllib.request.build_opener(SafeRedirect())
    for name, pin in PINS.items():
        start, count = time.monotonic(), 0
        request = urllib.request.Request(pin["url"], headers={"User-Agent": "Caddi-Synthetic-Speech-Evaluation/1"})
        with opener.open(request, timeout=30) as response, (work / pin["file"]).open("xb") as target:
            while True:
                require(not CANCELLED and time.monotonic() - start <= 180, "Download cancelled or timed out")
                require(shutil.disk_usage(work).free >= RESERVE, "Disk reserve reached")
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                count += len(chunk)
                require(count <= pin["bytes"], "Download exceeds pinned size")
                target.write(chunk)
        verify_resource(work / pin["file"], pin)
        records.append({"id": name, **pin})
    (work / "acquisition.json").write_text(json.dumps({"resources": records}, indent=2) + "\n")
    return {"status": "inputs_verified", "inputs": str(work.relative_to(ROOT))}


def group_quiescent(group_id):
    # macOS can report EPERM during the final zombie-only process-group transition.
    # Inspect only our group and accept disappearance or zombie states, never a live member.
    result = subprocess.run(["/bin/ps", "-g", str(group_id), "-o", "stat="], stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=2)
    require(len(result.stdout) <= 65536 and not result.stderr.strip() and result.returncode in (0, 1),
            "Cannot establish process-group quiescence")
    states = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if result.returncode == 1:
        require(not states, "Ambiguous process-group query")
        return True
    require(states, "Ambiguous process-group query")
    return all(state.startswith("Z") for state in states)


def stop_group(proc):
    if proc is None:
        return
    # Also terminate descendants when the original parent has already exited.
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except PermissionError:
        require(group_quiescent(proc.pid), "Live process group could not be stopped")
        return
    try:
        proc.wait(timeout=0.2)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        require(group_quiescent(proc.pid), "Live process group could not be stopped")
    if proc.poll() is None:
        proc.wait(timeout=5)


def run_stage(argv, cwd, env, log, timeout, records):
    require(not CANCELLED, "Evaluation cancelled")
    require(shutil.disk_usage(cwd).free >= RESERVE, "Disk reserve reached")
    require(0 < timeout <= 900, "Invalid stage deadline")
    started, count, proc, failure = time.monotonic(), 0, None, None
    selector = selectors.DefaultSelector()
    with Path(log).open("xb") as output:
        os.chmod(log, 0o600)
        try:
            proc = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            selector.register(proc.stdout, selectors.EVENT_READ)
            while selector.get_map() or proc.poll() is None:
                if CANCELLED:
                    failure = "cancelled"
                elif time.monotonic() - started >= timeout:
                    failure = "timeout"
                elif shutil.disk_usage(cwd).free < RESERVE:
                    failure = "disk_reserve"
                if failure:
                    break
                for key, _ in selector.select(0.1):
                    chunk = os.read(key.fileobj.fileno(), 16384)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    accepted = chunk[:max(0, MAX_LOG - count)]
                    output.write(accepted)
                    count += len(accepted)
                    if len(accepted) != len(chunk):
                        failure = "output_limit"
                        break
                if failure:
                    break
        finally:
            stop_group(proc)
            if proc and proc.stdout:
                proc.stdout.close()
            selector.close()
            output.flush()
            os.fsync(output.fileno())
    record = {"argv": [str(x) for x in argv], "log": Path(log).name, "wallSeconds": round(time.monotonic() - started, 6),
              "returncode": None if proc is None else proc.returncode, "limit": failure, "logBytes": count, "logSha256": digest(log)}
    records.append(record)
    require(not failure and record["returncode"] == 0, "Stage failed: " + Path(log).name)
    return record


def word_error(reference, hypothesis):
    ref = re.findall(r"[a-z0-9]+", reference.lower())
    hyp = re.findall(r"[a-z0-9]+", hypothesis.lower())
    require(ref and len(ref) <= 1000 and len(hyp) <= 1000, "Invalid scoring input size")
    previous = list(range(len(hyp) + 1))
    for i, word in enumerate(ref, 1):
        row = [i]
        for j, guess in enumerate(hyp, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j - 1] + (word != guess)))
        previous = row
    edits = previous[-1]
    return {"referenceWords": len(ref), "hypothesisWords": len(hyp), "wordEdits": edits, "wordErrorRate": edits / len(ref)}


def wav_info(path):
    with wave.open(str(path), "rb") as audio:
        require(audio.getnchannels() == 1 and audio.getsampwidth() == 2 and audio.getframerate() == 16000 and audio.getcomptype() == "NONE", "Expected mono 16-bit 16-kHz PCM")
        duration = audio.getnframes() / audio.getframerate()
        require(0 < duration <= 30, "Synthetic audio duration bound")
        return {"seconds": duration, "sha256": digest(path)}


def execute(inputs):
    require(platform.system() == "Darwin" and platform.machine() == "arm64", "Evaluation requires this Apple Silicon Mac")
    inputs = contained(inputs, BASE)
    for pin in PINS.values():
        verify_resource(inputs / pin["file"], pin)
    work = fresh_directory("evaluation-")
    records, results = [], []
    report = {"schemaVersion": 1, "status": "running", "syntheticOnly": True, "microphoneUsed": False,
              "cloudTranscription": False, "productionQualified": False, "sourceCommit": COMMIT,
              "modelCommit": MODEL_COMMIT, "inputs": PINS, "config": CONFIG,
              "host": {"platform": platform.platform(), "machine": platform.machine()},
              "runs": results, "stages": records}
    try:
        source, tools, build = work / "source", work / "tools", work / "build"
        report["sourceExtraction"] = extract_archive(inputs / PINS["source"]["file"], source, "tar", "whisper.cpp-" + COMMIT)
        report["toolExtraction"] = extract_archive(inputs / PINS["cmake"]["file"], tools, "zip")
        (work / "tmp").mkdir(mode=0o700)
        (work / "logs").mkdir(mode=0o700)
        (work / "audio").mkdir(mode=0o700)
        (work / "transcripts").mkdir(mode=0o700)
        cmake = tools / "cmake/data/bin/cmake"
        os.chmod(cmake, 0o700)
        env = {key: os.environ[key] for key in ("HOME", "USER") if key in os.environ}
        env.update({"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "TMPDIR": str(work / "tmp"),
                    "GIT_CEILING_DIRECTORIES": str(work), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                    "OMP_NUM_THREADS": "2", "VECLIB_MAXIMUM_THREADS": "2", "PYTHONDONTWRITEBYTECODE": "1"})
        # Keep this machine's paths out of the program: assert() and logging embed source file names.
        prefix_map = "-ffile-prefix-map={}=whisper.cpp -ffile-prefix-map={}=build".format(source, build)
        flags = {"CMAKE_C_FLAGS": prefix_map, "CMAKE_CXX_FLAGS": prefix_map}
        configure = [str(cmake), "-S", str(source), "-B", str(build), "-G", "Unix Makefiles"] + ["-D" + k + "=" + v for k, v in {**CONFIG, **flags}.items()]
        run_stage(configure, work, env, work / "logs/configure.log", 120, records)
        run_stage([str(cmake), "--build", str(build), "--target", "whisper-cli", "--parallel", "2"], work, env, work / "logs/build.log", 900, records)
        cli = build / "bin/whisper-cli"
        require(cli.is_file() and not cli.is_symlink(), "Expected local executable missing")
        report["binarySha256"] = digest(cli)
        report["licenseSha256"] = digest(source / "LICENSE")
        report["cmakeCacheSha256"] = digest(build / "CMakeCache.txt")
        cases = []
        for voice in VOICES:
            for name, reference in PROMPTS:
                case_id = voice.lower() + "-" + name
                aiff, wav = work / "audio" / (case_id + ".aiff"), work / "audio" / (case_id + ".wav")
                run_stage(["/usr/bin/say", "-v", voice, "-r", "165", "-o", str(aiff), reference], work, env, work / "logs" / (case_id + "-say.log"), 30, records)
                run_stage(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(aiff), str(wav)], work, env, work / "logs" / (case_id + "-convert.log"), 30, records)
                cases.append({"id": case_id, "voice": voice, "reference": reference, "path": wav, **wav_info(wav)})
        for repeat in range(2):
            for case in cases:
                run_id = case["id"] + "-" + str(repeat + 1)
                prefix = work / "transcripts" / run_id
                command = ["/usr/bin/time", "-lp", str(cli), "-m", str(inputs / PINS["model"]["file"]),
                           "-f", str(case["path"]), "-t", "2", "-l", "en", "-ng", "-nt", "-otxt", "-of", str(prefix)]
                timing = run_stage(command, work, env, work / "logs" / (run_id + ".log"), 90, records)
                transcript = prefix.with_suffix(".txt")
                require(transcript.is_file() and not transcript.is_symlink() and transcript.stat().st_size <= 65536, "Invalid transcript output")
                hypothesis = transcript.read_text().strip()
                memory = re.search(r"(\d+)\s+maximum resident set size", (work / "logs" / (run_id + ".log")).read_text())
                results.append({"id": run_id, "voice": case["voice"], "repeat": repeat + 1,
                                "processModelLoad": "fresh", "osCache": "uncontrolled-first-pass" if repeat == 0 else "repeated-input",
                                "audioSeconds": case["seconds"], "audioSha256": case["sha256"], "reference": case["reference"],
                                "transcript": hypothesis, "wallSeconds": timing["wallSeconds"], "realTimeFactor": timing["wallSeconds"] / case["seconds"],
                                "peakResidentBytes": int(memory.group(1)) if memory else None, **word_error(case["reference"], hypothesis)})
                print(json.dumps({"stage": "transcribed", "id": run_id, "wallSeconds": timing["wallSeconds"], "wordErrorRate": results[-1]["wordErrorRate"]}), flush=True)
        report["status"] = "synthetic_completed"
        report["wordErrorRate"] = sum(x["wordEdits"] for x in results) / sum(x["referenceWords"] for x in results)
        report["limitations"] = ["Six clean synthetic utterances from two installed voices; no microphone, background noise or human accents.",
                                "Every timed run reloads the model. Repeated inputs may benefit from OS file cache; no resident warm-model claim.",
                                "No browser capture integration, transcription cancellation/privacy-barrier or signed distribution qualification."]
    except Exception as error:
        report["status"] = "blocked"
        report["error"] = type(error).__name__ + ": " + str(error)
    (work / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return {"status": report["status"], "report": str((work / "report.json").relative_to(ROOT)), "runs": len(results)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--download", action="store_true")
    action.add_argument("--execute", action="store_true")
    parser.add_argument("--inputs", type=Path)
    args = parser.parse_args()
    def cancel(_signal, _frame):
        global CANCELLED
        CANCELLED = True
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        if args.download:
            result = download()
        elif args.execute:
            require(args.inputs is not None, "--execute requires pinned --inputs")
            result = execute(args.inputs)
        else:
            result = {"mode": "plan", "executed": False, "sourceVersion": "v1.9.5", "pins": PINS,
                      "config": CONFIG, "voices": VOICES, "prompts": PROMPTS, "maxBuildJobs": 2,
                      "stageDeadlineSeconds": 900, "stageLogLimitBytes": MAX_LOG, "diskReserveBytes": RESERVE}
        print(json.dumps(result, indent=2))
        return 2 if result.get("status") == "blocked" else 0
    except Exception as error:
        print(json.dumps({"status": "blocked", "error": type(error).__name__ + ": " + str(error)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
