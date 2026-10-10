#!/bin/sh
# -------------------------------------------------------------
# Daily backup of the household data on the garage server.
#
# All the real data (inventory, recipes, prices, the activity log,
# stock minimums, saved barcodes...) lives ONLY in the .csv files in
# /opt/Ingredients_And_Recipes - they're deliberately kept out of
# GitHub. So if the garage's disk died, or something got wiped by
# mistake, there'd be no other copy. This makes one every day.
#
# Each backup is one small zipped file, named by date, e.g.
#   /opt/pantry-backups/pantry-2026-10-14.tar.gz
# Backups older than 30 days are deleted automatically, so the
# folder never fills up the disk.
#
# SETTING IT UP (once, on the garage, as root):
#   crontab -e
# and add this line at the bottom, which runs it at 3am every night:
#   0 3 * * * sh /opt/Ingredients_And_Recipes/backup-data.sh
#
# RESTORING A BACKUP (e.g. the one from 14 Oct):
#   systemctl stop ingredients-recipes
#   cd /opt/Ingredients_And_Recipes
#   tar -xzf /opt/pantry-backups/pantry-2026-10-14.tar.gz
#   systemctl start ingredients-recipes
# -------------------------------------------------------------

APP_FOLDER=/opt/Ingredients_And_Recipes
BACKUP_FOLDER=/opt/pantry-backups
KEEP_DAYS=30

mkdir -p "$BACKUP_FOLDER"

# Zip up every .csv file (plus sessions.json, so nobody gets logged
# out after a restore). "|| true" = carry on even if sessions.json
# doesn't exist yet.
cd "$APP_FOLDER" || exit 1
tar -czf "$BACKUP_FOLDER/pantry-$(date +%F).tar.gz" *.csv $(ls sessions.json 2>/dev/null) || exit 1

# Delete backups older than KEEP_DAYS days.
find "$BACKUP_FOLDER" -name 'pantry-*.tar.gz' -mtime +$KEEP_DAYS -delete
