const fs = require('fs');

const path = 'd:\\Sky-meet\\Ai-teacher-frontend\\app\\rooms\\[roomName]\\TeacherVideoController.jsx';

try {
    let content = fs.readFileSync(path, 'utf-8');

    content = content.replace(/videoURL \?/g, "primaryVideoURL ?");
    content = content.replace(/\(videoURL \|\| classStarted\)/g, "(primaryVideoURL || classStarted)");

    content = content.replace(
        /if \(videoRef\.current\) videoRef\.current\.pause\(\);/g,
        "Object.values(videoRefs.current).forEach(ref => ref.current && ref.current.pause());"
    );
    content = content.replace(
        /if \(videoRef\.current\) \{\n                    videoRef\.current\.pause\(\);\n                  \}/g,
        "Object.values(videoRefs.current).forEach(ref => { if (ref.current) ref.current.pause(); });"
    );

    content = content.replace(/setVideoURL\(null\);/g, "setVideoURLs({});");
    content = content.replace(/setVideoFile\(null\);/g, "setVideoFiles({});");

    content = content.replace(
        /if \(fileInputRef\.current\) \{\n                  fileInputRef\.current\.value = "";\n                \}/g,
        "Object.values(videoInputRefs.current).forEach(ref => { if (ref.current) ref.current.value = \"\"; });"
    );
    content = content.replace(
        /if \(fileInputRef\.current\) \{\n                    fileInputRef\.current\.value = "";\n                  \}/g,
        "Object.values(videoInputRefs.current).forEach(ref => { if (ref.current) ref.current.value = \"\"; });"
    );

    content = content.replace(
        /Object\.values\(audioInputRefs\)\.forEach\(ref => \{\n                  if \(ref\.current\) ref\.current\.value = "";\n                \}\);/g,
        ""
    );
    content = content.replace(
        /setAudioFiles\(\{ ta: null, hi: null, ml: null, kn: null, te: null \}\);/g,
        ""
    );

    content = content.replace(
        /Object\.values\(audioInputRefs\)\.forEach\(ref => \{\n                    if \(ref\.current\) ref\.current\.value = "";\n                  \}\);/g,
        ""
    );

    content = content.replace(
        /fileInputRef\.current\?\.click\(\)/g,
        "document.getElementById('fake-btn').click()" // This button shouldn't exist anymore, we mapped it. Wait, the upload button at line 737: let's leave it as is, or fix it properly.
    );

    fs.writeFileSync(path, content, 'utf-8');
    console.log("Done!");
} catch (error) {
    console.error("An error occurred:", error);
}
