if (!$._LocalStream) {
  $._LocalStream = {};
}

$._LocalStream.importCompletedFile = function (path) {
  try {
    if (typeof path !== "string" || path.length === 0) {
      return "ERROR:Export file path is missing.";
    }

    var file = new File(path);
    if (!file.exists) {
      return "ERROR:Export file was not found on disk.";
    }

    if (!app.project || !app.project.rootItem) {
      return "ERROR:Open a Premiere project before importing an export.";
    }

    var root = app.project.rootItem;
    var binName = "LocalStream Downloads";
    var targetBin = null;
    var legacyBin = null;
    var i;

    for (i = 0; i < root.children.numItems; i++) {
      if (root.children[i].type === 2) {
        if (root.children[i].name === binName) {
          targetBin = root.children[i];
          break;
        }
        if (root.children[i].name === "Local Stream") {
          legacyBin = root.children[i];
        }
      }
    }

    if (!targetBin && legacyBin) {
      legacyBin.name = binName;
      targetBin = legacyBin;
    }

    if (!targetBin) {
      try {
        targetBin = root.createBin(binName);
      } catch (binError) {
        targetBin = null;
      }
      if (!targetBin) {
        for (i = 0; i < root.children.numItems; i++) {
          if (root.children[i].type === 2 && root.children[i].name === binName) {
            targetBin = root.children[i];
            break;
          }
        }
      }
    }

    var imported = app.project.importFiles([file.fsName], true, targetBin || root, false);
    if (!imported) {
      return "ERROR:Premiere did not import the export file.";
    }
    return "OK";
  } catch (error) {
    return "ERROR:" + error.toString();
  }
};
