// Headless driver for the upstream avbd-demo2d solver (reference/avbd-demo2d). Steps a scene
// and prints body poses as JSON so the TypeScript port can be diffed against the original.
// Usage: oracle2d <sceneIndex> <frame,frame,...>   (samples the given frames, ascending)
#include <cstdio>
#include <cstdlib>
#include <set>
#include <sstream>
#include <string>
#include <vector>
#include "solver.h"
#include "scenes.h"

int main(int argc, char** argv)
{
    if (argc < 3) { fprintf(stderr, "usage: oracle2d <scene> <frame,frame,...>\n"); return 1; }
    int scene = atoi(argv[1]);
    std::set<int> sampleFrames;
    std::stringstream list(argv[2]);
    for (std::string item; std::getline(list, item, ',');) sampleFrames.insert(atoi(item.c_str()));
    int frames = *sampleFrames.rbegin();

    Solver* solver = new Solver();
    scenes[scene](solver);

    printf("{\"scene\":\"%s\",\"samples\":[", sceneNames[scene]);
    bool firstSample = true;
    for (int f = 0; f <= frames; f++)
    {
        if (sampleFrames.count(f))
        {
            // The body list is newest-first; emit in creation order to match the port.
            std::vector<Rigid*> bodies;
            for (Rigid* b = solver->bodies; b; b = b->next) bodies.push_back(b);
            int forces = 0;
            for (Force* x = solver->forces; x; x = x->next) forces++;
            printf("%s{\"frame\":%d,\"forces\":%d,\"bodies\":[", firstSample ? "" : ",", f, forces);
            for (size_t i = 0; i < bodies.size(); i++)
            {
                Rigid* b = bodies[bodies.size() - 1 - i];
                printf("%s[%.17g,%.17g,%.17g]", i ? "," : "", b->position.x, b->position.y, b->position.z);
            }
            printf("]}");
            firstSample = false;
        }
        if (f < frames) solver->step();
    }
    printf("]}\n");
    return 0;
}
