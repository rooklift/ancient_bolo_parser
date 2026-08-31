node ./tools/report-interpolation-rates.cjs > report.txt
node ./tools/audit-drawn-motion.cjs > audit.txt

utf16_to_8.py report.txt
utf16_to_8.py audit.txt
