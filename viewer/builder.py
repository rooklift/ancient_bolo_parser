zips = {
	"windows": "electron_zipped/electron-v43.4.1-win32-x64.zip",
	"linux": "electron_zipped/electron-v43.4.1-linux-x64.zip",
}


# To build the Ancient Bolo Log Viewer: (for info see https://electronjs.org/docs/tutorial/application-distribution)
#
# Obtain the appropriate Electron asset named above, from https://github.com/electron/electron/releases
# Create a folder called ./electron_zipped and place the Electron asset in it
# Run ./builder.py from this directory (viewer/)


import json, os, shutil, subprocess, sys, zipfile

try:
	branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, encoding="utf8", check=True).stdout.strip()
except (OSError, subprocess.CalledProcessError):
	sys.exit("builder.py: cannot determine the git branch; refusing to build.")
if branch != "main":
	sys.exit("builder.py: on branch \"{}\", not \"main\"; refusing to build.".format(branch))

with open("package.json") as f:
	pj = json.load(f)
	name = pj["name"]
	version = pj["version"]

useful_files = [file for file in os.listdir() if file.endswith(".js") or file.endswith(".html") or file.endswith(".css") or file == "package.json"]
folders = ["sprites"]

for key, value in zips.items():
	if not os.path.exists(value):
		continue
	build_dir = "dist/{}-{}-{}".format(name, version, key)
	build_app_dir = os.path.join(build_dir, "resources/app")
	os.makedirs(build_app_dir)
	for file in useful_files:
		shutil.copy(file, build_app_dir)
	for folder in folders:
		shutil.copytree(folder, os.path.join(build_app_dir, folder))
	print("Extracting for {}...".format(key))
	z = zipfile.ZipFile(value, "r")
	z.extractall(build_dir)
	z.close()
	if os.path.exists(os.path.join(build_dir, "electron.exe")):
		os.rename(os.path.join(build_dir, "electron.exe"), os.path.join(build_dir, "{}.exe".format(name)))
	if os.path.exists(os.path.join(build_dir, "electron")):
		os.rename(os.path.join(build_dir, "electron"), os.path.join(build_dir, name))

	# Remove unneeded locale files
	locales_dir = os.path.join(build_dir, "locales")
	if os.path.exists(locales_dir):
		for file in os.listdir(locales_dir):
			if file.endswith(".pak") and file != "en-US.pak":
				os.remove(os.path.join(locales_dir, file))

	# We could and maybe should...
	"""
	if key == "windows":
		electron_exe = os.path.join(build_dir, "{}.exe".format(name))
		print("Running rcedit...")
		subprocess.run([
			"rcedit-x64.exe",
			electron_exe,
			"--set-version-string", "FileDescription", "Ancient Bolo Log Viewer",
			"--set-version-string", "ProductName", "Ancient Bolo Log Viewer",
			"--set-version-string", "LegalCopyright", "Copyright 2026 Rooklift",
			"--set-file-version", version,
			"--set-product-version", version
		], check=True)
	"""
